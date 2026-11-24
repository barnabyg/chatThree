import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { solidPng } from '../../../test-support/png.ts';
import type { Chat, ScenarioInput } from '../../shared/api.ts';
import { ProviderError } from '../chat/provider.ts';
import { EngineUnavailableError, type PaintRequest } from '../engine/jobs.ts';
import {
  BLANK_SCENARIO,
  builtInCharacter,
  replyEvents,
  type TestApp,
  testApp,
} from '../testing.ts';

const LIGHTHOUSE: ScenarioInput = {
  ...BLANK_SCENARIO,
  title: 'The Storm at Gull Point',
  premise: 'A storm traps a traveller in a lighthouse.',
  openingMessage: 'You are soaked through. Come in.',
  startingLocation: {
    name: 'The lamp room',
    description: 'A round glass room at the top of the tower.',
  },
};

/** An app whose character has a picture, and a chat that has begun with its opening message. */
async function illustratable(): Promise<{ app: TestApp; chat: Chat }> {
  const app = testApp();
  const character = await builtInCharacter(app);
  await app.upload(
    'PUT',
    `/api/characters/${character.id}/image`,
    solidPng(8, 8, [10, 20, 30]),
  );
  const chat = await app.startChat({
    scenarioId: app.scenarios.create(LIGHTHOUSE).id,
  });
  return { app, chat };
}

async function readChat(app: TestApp, id: string): Promise<Chat> {
  return (await (await app.call('GET', `/api/chats/${id}`)).json()) as Chat;
}

function illustrate(
  app: TestApp,
  chat: Chat,
  messageId: number | undefined,
): Promise<Response> {
  return app.call(
    'POST',
    `/api/chats/${chat.id}/messages/${String(messageId)}/illustrate`,
  );
}

/** The chat once nothing is being illustrated in it any more. */
async function settled(app: TestApp, chat: Chat): Promise<Chat> {
  await expect
    .poll(async () =>
      (await readChat(app, chat.id)).illustrating.filter(
        ({ state }) => state !== 'failed',
      ),
    )
    .toEqual([]);
  return readChat(app, chat.id);
}

function painted(app: TestApp): PaintRequest[] {
  return app.jobs.requests.flatMap((request) =>
    request.job === 'paint' ? [request] : [],
  );
}

function files(app: TestApp, folder: string): string[] {
  const directory = path.join(app.dataDir, folder);
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe('illustrating a message', () => {
  test('the picture is painted from the character and the starting location, and is kept with the chat', async () => {
    const { app, chat } = await illustratable();
    const opening = chat.messages[0];

    const started = await illustrate(app, chat, opening?.id);

    expect(started.status).toBe(202);
    expect(((await started.json()) as Chat).illustrating).toEqual([
      { messageId: opening?.id, state: 'describing' },
    ]);
    const done = await settled(app, chat);
    expect(done.illustrations).toEqual([
      {
        id: expect.any(Number) as number,
        messageId: opening?.id,
        imageUrl: expect.stringMatching(/^\/api\/chats\/.+\/image$/) as string,
      },
    ]);
    const served = await app.call('GET', done.illustrations[0]?.imageUrl ?? '');
    expect(served.headers.get('Content-Type')).toBe('image/png');

    // The starting location is painted first, alone, then the scene from both.
    const [place, scene] = painted(app);
    expect(place?.prompt).toContain('The lamp room');
    expect(place?.prompt).toContain('A round glass room');
    expect(place?.references).toBeUndefined();
    expect(scene?.prompt).toContain('Mara trims the wick of the great lamp.');
    expect(scene?.width).toBeGreaterThan(scene?.height ?? Infinity);
    const character = await builtInCharacter(app);
    expect(scene?.references).toEqual([
      path.join(app.dataDir, app.characters.imageFile(character.id) ?? ''),
      path.join(app.dataDir, 'locations', files(app, 'locations')[0] ?? ''),
    ]);
  });

  test('the scene call reads the recent messages with the scene model', async () => {
    const { app, chat } = await illustratable();
    app.settings.update({ sceneModel: 'small-model' });
    app.provider.script({ pieces: ['"Up the stairs," she says.'] });
    await replyEvents(
      await app.call('POST', `/api/chats/${chat.id}/messages`, {
        content: 'Where is the lamp?',
      }),
    );
    const reply = (await readChat(app, chat.id)).messages.at(-1);

    await illustrate(app, chat, reply?.id);
    await settled(app, chat);

    const [request] = app.provider.structuredRequests;
    expect(request?.model).toBe('small-model');
    expect(request?.input).toContain('You are soaked through. Come in.');
    expect(request?.input).toContain('Where is the lamp?');
    expect(request?.input).toContain('"Up the stairs," she says.');
    expect(request?.instructions).toContain('The lamp room');
  });

  test("the location's reference picture is made once, then reused", async () => {
    const { app, chat } = await illustratable();
    const opening = chat.messages[0]?.id;

    await illustrate(app, chat, opening);
    await settled(app, chat);
    await illustrate(app, chat, opening);
    const done = await settled(app, chat);

    expect(done.illustrations).toHaveLength(2);
    expect(painted(app).map(({ references }) => references?.length)).toEqual([
      undefined,
      2,
      2,
    ]);
    expect(files(app, 'locations')).toHaveLength(1);
  });

  test('a character without a reference picture cannot be illustrated', async () => {
    const app = testApp();
    const chat = await app.startChat({
      scenarioId: app.scenarios.create(LIGHTHOUSE).id,
    });

    const response = await illustrate(app, chat, chat.messages[0]?.id);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Illustrating needs a reference picture of Mara Quill. Give Mara Quill a picture first.',
    });
    expect(app.provider.structuredRequests).toHaveLength(0);
  });

  test("only the character's messages can be illustrated", async () => {
    const { app, chat } = await illustratable();
    await replyEvents(
      await app.call('POST', `/api/chats/${chat.id}/messages`, {
        content: 'Thank you.',
      }),
    );
    const mine = (await readChat(app, chat.id)).messages.find(
      ({ role }) => role === 'user',
    );

    const response = await illustrate(app, chat, mine?.id);
    const missing = await illustrate(app, chat, 999_999);

    expect(response.status).toBe(400);
    expect(missing.status).toBe(400);
  });

  test('a message already being illustrated is not started twice', async () => {
    const { app, chat } = await illustratable();
    const finish = app.jobs.holdPainting();

    await illustrate(app, chat, chat.messages[0]?.id);
    const again = await illustrate(app, chat, chat.messages[0]?.id);
    finish();

    expect(again.status).toBe(409);
    expect((await settled(app, chat)).illustrations).toHaveLength(1);
  });

  test('progress shows the location and then the scene being painted', async () => {
    const { app, chat } = await illustratable();
    const finish = app.jobs.holdPainting();

    await illustrate(app, chat, chat.messages[0]?.id);

    await expect
      .poll(async () => (await readChat(app, chat.id)).illustrating[0]?.state)
      .toBe('painting-location');
    finish();
    await settled(app, chat);
  });

  test('a failed scene call is shown, with the reason, and can be tried again', async () => {
    const { app, chat } = await illustratable();
    app.provider.scriptStructured({
      fail: new ProviderError('OpenAI rejected the API key.'),
    });

    await illustrate(app, chat, chat.messages[0]?.id);
    await expect
      .poll(async () => (await readChat(app, chat.id)).illustrating)
      .toEqual([
        {
          messageId: chat.messages[0]?.id,
          state: 'failed',
          error: 'OpenAI rejected the API key.',
        },
      ]);

    const retried = await illustrate(app, chat, chat.messages[0]?.id);
    expect(retried.status).toBe(202);
    const done = await settled(app, chat);
    expect(done.illustrations).toHaveLength(1);
    expect(done.illustrating).toEqual([]);
  });

  test('an answer that does not follow the schema is a failure', async () => {
    const { app, chat } = await illustratable();
    app.provider.scriptStructured({ value: { action: '' } });

    await illustrate(app, chat, chat.messages[0]?.id);

    await expect
      .poll(async () => (await readChat(app, chat.id)).illustrating[0]?.error)
      .toContain('could not use');
  });

  test('an engine that is not ready is a failure', async () => {
    const { app, chat } = await illustratable();
    app.jobs.failWith(new EngineUnavailableError());

    await illustrate(app, chat, chat.messages[0]?.id);

    await expect
      .poll(async () => (await readChat(app, chat.id)).illustrating[0]?.error)
      .toBe('The picture cannot be made because the engine is not ready.');
  });

  test("a deleted message's pictures are deleted with it", async () => {
    const { app, chat } = await illustratable();
    await illustrate(app, chat, chat.messages[0]?.id);
    await settled(app, chat);
    expect(files(app, 'scenes')).toHaveLength(1);

    await app.call('DELETE', `/api/chats/${chat.id}/messages/last`);

    expect(files(app, 'scenes')).toEqual([]);
    expect((await readChat(app, chat.id)).illustrations).toEqual([]);
  });

  test("a deleted chat's pictures are deleted with it", async () => {
    const { app, chat } = await illustratable();
    await illustrate(app, chat, chat.messages[0]?.id);
    await settled(app, chat);

    await app.call('DELETE', `/api/chats/${chat.id}`);

    expect(files(app, 'scenes')).toEqual([]);
    expect(files(app, 'locations')).toEqual([]);
  });
});
