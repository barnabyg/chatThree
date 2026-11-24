import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Character } from '../../shared/api.ts';
import { recording } from '../../../test-support/recording.ts';
import {
  builtInCharacter,
  stubEngine,
  type TestApp,
  testApp,
} from '../testing.ts';

async function giveVoice(
  app: TestApp,
  character: Character,
  clip = recording(6),
): Promise<Response> {
  return app.upload('PUT', `/api/characters/${character.id}/voice`, clip);
}

/** Speak a sentence as the character, and return the clip the engine was pointed at. */
async function voiceUsedFor(
  app: TestApp,
  character: Character,
): Promise<string | undefined> {
  const response = await app.call('POST', '/api/speech', {
    text: 'Sit down.',
    characterId: character.id,
  });
  expect(response.status).toBe(200);
  const request = app.jobs.requests.at(-1);
  return request?.job === 'speak' ? request.voice : undefined;
}

describe('giving a character a voice', () => {
  test('a character starts without a voice clip, and speaks in the built-in voice', async () => {
    const app = testApp();
    const character = await builtInCharacter(app);

    expect(character.hasVoice).toBe(false);
    expect(await voiceUsedFor(app, character)).toBeUndefined();
  });

  test('its replies are then spoken from the uploaded clip', async () => {
    const app = testApp();
    const character = await builtInCharacter(app);
    const clip = recording(6);

    const response = await giveVoice(app, character, clip);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: character.id,
      hasVoice: true,
    });
    const used = await voiceUsedFor(app, character);
    expect(new Uint8Array(readFileSync(used ?? ''))).toEqual(clip);
  });

  test("the clip is kept in the app's data folder", async () => {
    const app = testApp();
    const character = await builtInCharacter(app);
    await giveVoice(app, character);

    const used = (await voiceUsedFor(app, character)) ?? '';

    expect(path.dirname(used)).toBe(path.join(app.dataDir, 'voices'));
  });

  test('a clip too short to clone from is refused, saying how long it must be', async () => {
    const app = testApp();
    const character = await builtInCharacter(app);

    const response = await giveVoice(app, character, recording(2.5));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'That recording is 2.5 seconds long. A voice clip must be longer than 5 seconds.',
    });
    expect((await builtInCharacter(app)).hasVoice).toBe(false);
  });

  test('a file that is not a WAV recording is refused', async () => {
    const app = testApp();

    const response = await giveVoice(
      app,
      await builtInCharacter(app),
      new Uint8Array([1, 2, 3, 4]),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A voice clip must be a WAV recording.',
    });
  });

  test('an unknown character is a 404', async () => {
    const app = testApp();

    const response = await app.upload(
      'PUT',
      '/api/characters/no-such-id/voice',
      recording(6),
    );

    expect(response.status).toBe(404);
  });
});

test('a new clip replaces the old one, under a new name', async () => {
  const app = testApp();
  const character = await builtInCharacter(app);
  await giveVoice(app, character, recording(6, 220));
  const first = (await voiceUsedFor(app, character)) ?? '';
  const replacement = recording(7, 330);

  await giveVoice(app, character, replacement);

  const second = (await voiceUsedFor(app, character)) ?? '';
  // The engine remembers a voice by its clip's path, so the path must change.
  expect(second).not.toBe(first);
  expect(new Uint8Array(readFileSync(second))).toEqual(replacement);
  expect(existsSync(first)).toBe(false);
});

test('removing the clip goes back to the built-in voice, and deletes the file', async () => {
  const app = testApp();
  const character = await builtInCharacter(app);
  await giveVoice(app, character);
  const clip = (await voiceUsedFor(app, character)) ?? '';

  const response = await app.call(
    'DELETE',
    `/api/characters/${character.id}/voice`,
  );

  expect(await response.json()).toMatchObject({ hasVoice: false });
  expect(await voiceUsedFor(app, character)).toBeUndefined();
  expect(existsSync(clip)).toBe(false);
});

test("deleting a character deletes its voice clip's file", async () => {
  const app = testApp();
  const character = await builtInCharacter(app);
  await giveVoice(app, character);
  const clip = (await voiceUsedFor(app, character)) ?? '';

  await app.call('DELETE', `/api/characters/${character.id}`);

  expect(existsSync(clip)).toBe(false);
});

test('speaking as a character that does not exist is a 404', async () => {
  const response = await testApp().call('POST', '/api/speech', {
    text: 'Sit down.',
    characterId: 'no-such-id',
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: 'That character does not exist.',
  });
});

describe('warming a voice up', () => {
  async function warm(app: TestApp, character: Character): Promise<Response> {
    return app.call('POST', `/api/characters/${character.id}/voice/warm`);
  }

  test("has the engine prepare the character's clip", async () => {
    const app = testApp();
    const character = await builtInCharacter(app);
    await giveVoice(app, character);

    const response = await warm(app, character);

    expect(response.status).toBe(204);
    await expect
      .poll(() => app.jobs.requests)
      .toEqual([
        {
          job: 'prepare-voice',
          voice: expect.stringContaining(
            path.join(app.dataDir, 'voices'),
          ) as string,
        },
      ]);
  });

  test('asks nothing of the engine for a character with the built-in voice', async () => {
    const app = testApp();

    const response = await warm(app, await builtInCharacter(app));

    expect(response.status).toBe(204);
    await Promise.resolve();
    expect(app.jobs.requests).toEqual([]);
  });

  test('asked while the engine is still loading, happens once the engine is ready', async () => {
    const engine = stubEngine({ state: 'loading' });
    const app = testApp({ engine });
    const character = await builtInCharacter(app);
    await giveVoice(app, character);

    // Asked twice, as when the chat is opened twice: it is done once.
    await warm(app, character);
    const response = await warm(app, character);
    expect(response.status).toBe(204);
    expect(app.jobs.requests).toEqual([]);

    engine.set({ state: 'ready' });

    await expect.poll(() => app.jobs.requests).toHaveLength(1);
    expect(app.jobs.requests[0]?.job).toBe('prepare-voice');
  });
});
