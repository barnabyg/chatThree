import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Character } from '../../shared/api.ts';
import {
  EngineFailedError,
  EngineUnavailableError,
  type PaintRequest,
} from '../engine/jobs.ts';
import { fakePicture, type TestApp, testApp } from '../testing.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function mara(app: TestApp): Promise<Character> {
  const response = await app.call('GET', '/api/characters');
  const [character] = (await response.json()) as Character[];
  if (character === undefined) throw new Error('expected a character');
  return character;
}

async function generate(
  app: TestApp,
  character: Character,
  body?: object,
): Promise<Response> {
  return app.call(
    'POST',
    `/api/characters/${character.id}/image/generate`,
    body ?? {},
  );
}

/** What the engine has been asked to paint, oldest first. */
function painted(app: TestApp): PaintRequest[] {
  return app.jobs.requests.flatMap((request) =>
    request.job === 'paint' ? [request] : [],
  );
}

/** The picture a character's address serves. */
async function picture(app: TestApp, character: Character): Promise<Response> {
  return app.call('GET', character.imageUrl ?? '/api/no-picture');
}

async function pictureBytes(
  app: TestApp,
  character: Character,
): Promise<number[]> {
  const served = await picture(app, character);
  return [...new Uint8Array(await served.arrayBuffer())];
}

/** The files the app is keeping for characters' pictures. */
function pictureFiles(app: TestApp): string[] {
  const folder = path.join(app.dataDir, 'images');
  return existsSync(folder) ? readdirSync(folder) : [];
}

describe('generating a reference picture', () => {
  test('a character starts without one', async () => {
    const app = testApp();
    const character = await mara(app);

    expect(character.imageUrl).toBeNull();
    const response = await app.call(
      'GET',
      `/api/characters/${character.id}/image`,
    );
    expect(response.status).toBe(404);
  });

  test("has the engine paint the character's appearance, upright", async () => {
    const app = testApp();
    const character = await mara(app);

    const response = await generate(app, character);

    expect(response.status).toBe(200);
    const [request] = painted(app);
    expect(request?.prompt).toContain(character.appearance);
    expect(request?.prompt).toContain('character reference picture');
    expect(request).toMatchObject({ width: 768, height: 1024 });
  });

  test("keeps the picture with the character, in the app's data folder", async () => {
    const app = testApp();
    const before = await mara(app);

    const generated = (await (await generate(app, before)).json()) as Character;

    expect(generated.imageUrl).toEqual(expect.any(String));
    expect((await mara(app)).imageUrl).toBe(generated.imageUrl);
    const served = await picture(app, generated);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(
      fakePicture(painted(app)[0]?.seed ?? -1),
    );
    expect(pictureFiles(app)).toHaveLength(1);
  });

  test('paints from the appearance sent with the request, which may not be saved yet', async () => {
    const app = testApp();
    const character = await mara(app);

    await generate(app, character, {
      appearance: 'A tall man in a red coat.',
    });

    expect(painted(app)[0]?.prompt).toContain('A tall man in a red coat.');
    expect(painted(app)[0]?.prompt).not.toContain(character.appearance);
    // Painting does not save the text.
    expect((await mara(app)).appearance).toBe(character.appearance);
  });

  test('generating again makes a different picture, which replaces the first', async () => {
    const app = testApp();
    const character = await mara(app);
    const first = (await (await generate(app, character)).json()) as Character;
    const firstBytes = await pictureBytes(app, first);

    const second = (await (await generate(app, character)).json()) as Character;

    const [one, two] = painted(app);
    expect(two?.seed).not.toBe(one?.seed);
    expect(two?.prompt).toBe(one?.prompt);
    // A new address, so that a browser does not show the old picture.
    expect(second.imageUrl).not.toBe(first.imageUrl);
    expect(await pictureBytes(app, second)).not.toEqual(firstBytes);
    expect(pictureFiles(app)).toHaveLength(1);
  });

  test('is refused for a character with no appearance, saying what to do', async () => {
    const app = testApp();
    const character = await mara(app);

    const response = await generate(app, character, { appearance: '  ' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Describe the appearance first: the picture is made from it.',
    });
    expect(painted(app)).toEqual([]);
  });

  test.each<{ name: string; failure: Error; status: number; error: string }>([
    {
      name: 'an engine that is not ready',
      failure: new EngineUnavailableError(),
      status: 503,
      error: 'A picture cannot be made because the engine is not ready.',
    },
    {
      name: 'an engine that breaks on the picture',
      failure: new EngineFailedError('The engine failed (500).'),
      status: 502,
      error: 'The engine could not make the picture.',
    },
  ])('$name says so, and the character is unchanged', async (scenario) => {
    const app = testApp();
    const character = await mara(app);
    app.jobs.failWith(scenario.failure);

    const response = await generate(app, character);

    expect(response.status).toBe(scenario.status);
    expect(await response.json()).toEqual({ error: scenario.error });
    expect((await mara(app)).imageUrl).toBeNull();
  });
});

describe("uploading a picture of the user's own", () => {
  test('keeps it as the reference picture, served as the kind of image it is', async () => {
    const app = testApp();
    const character = await mara(app);

    const response = await app.upload(
      'PUT',
      `/api/characters/${character.id}/image`,
      JPEG,
    );

    expect(response.status).toBe(200);
    const served = await picture(app, (await response.json()) as Character);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG);
  });

  test('replaces a generated picture', async () => {
    const app = testApp();
    const character = await mara(app);
    await generate(app, character);

    await app.upload('PUT', `/api/characters/${character.id}/image`, JPEG);

    const served = await picture(app, await mara(app));
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG);
    expect(pictureFiles(app)).toHaveLength(1);
  });

  test('a file that is not a picture is refused', async () => {
    const app = testApp();
    const character = await mara(app);

    const response = await app.upload(
      'PUT',
      `/api/characters/${character.id}/image`,
      new Uint8Array(new TextEncoder().encode('These are notes.')),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A picture must be a PNG, JPEG or WebP image.',
    });
    expect((await mara(app)).imageUrl).toBeNull();
  });
});

test("deleting a character deletes its picture's file", async () => {
  const app = testApp();
  const character = await mara(app);
  await generate(app, character);

  await app.call('DELETE', `/api/characters/${character.id}`);

  expect(pictureFiles(app)).toEqual([]);
});
