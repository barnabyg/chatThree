import { describe, expect, test, vi } from 'vitest';
import { solidPng } from '../../../test-support/png.ts';
import type { Chat, IllustrationMode, ReplyEvent } from '../../shared/api.ts';
import { ProviderError } from '../chat/provider.ts';
import {
  BLANK_SCENARIO,
  builtInCharacter,
  PLAIN_SCENE,
  replyEvents,
  type ScriptedAnswer,
  type TestApp,
  testApp,
} from '../testing.ts';

/** Scene call answers. */
const ORDINARY: ScriptedAnswer = { value: PLAIN_SCENE };
const WORTH_IT: ScriptedAnswer = {
  value: { ...PLAIN_SCENE, worthIllustrating: true },
};
function movedTo(name: string): ScriptedAnswer {
  return {
    value: {
      ...PLAIN_SCENE,
      moved: true,
      location: { name, description: `${name}, as it looks.` },
    },
  };
}

async function setUp(
  mode?: IllustrationMode,
): Promise<{ app: TestApp; chat: Chat }> {
  const app = testApp();
  const character = await builtInCharacter(app);
  await app.upload(
    'PUT',
    `/api/characters/${character.id}/image`,
    solidPng(8, 8, [10, 20, 30]),
  );
  if (mode !== undefined) app.settings.update({ illustrationMode: mode });
  const chat = await app.startChat({
    scenarioId: app.scenarios.create({
      ...BLANK_SCENARIO,
      startingLocation: { name: 'The kitchen', description: 'A stove.' },
    }).id,
  });
  return { app, chat };
}

async function readChat(app: TestApp, id: string): Promise<Chat> {
  return (await (await app.call('GET', `/api/chats/${id}`)).json()) as Chat;
}

/** The chat once nothing is happening in it in the background. */
async function settled(app: TestApp, chat: Chat): Promise<Chat> {
  await expect
    .poll(async () => {
      const now = await readChat(app, chat.id);
      return (
        now.followingScene ||
        now.illustrating.some(({ state }) => state !== 'failed')
      );
    })
    .toBe(false);
  return readChat(app, chat.id);
}

/** Send a message and wait for the reply, and what follows it, to finish. */
async function reply(
  app: TestApp,
  chat: Chat,
  scene: ScriptedAnswer = ORDINARY,
): Promise<ReplyEvent[]> {
  app.provider.scriptStructured(scene);
  const events = await replyEvents(
    await app.call('POST', `/api/chats/${chat.id}/messages`, {
      content: 'Go on.',
    }),
  );
  await settled(app, chat);
  return events;
}

/** Which replies, counted from 1, have a picture. */
async function illustratedReplies(app: TestApp, chat: Chat): Promise<number[]> {
  const now = await readChat(app, chat.id);
  const replies = now.messages.filter(({ role }) => role === 'assistant');
  return replies.flatMap((message, index) =>
    now.illustrations.some(({ messageId }) => messageId === message.id)
      ? [index + 1]
      : [],
  );
}

describe('illustrating replies by themselves', () => {
  test('after each reply the scene call runs, and follows the story', async () => {
    const { app, chat } = await setUp();

    await reply(app, chat, movedTo('The jetty'));

    expect(app.provider.structuredRequests).toHaveLength(1);
    expect((await readChat(app, chat.id)).location.name).toBe('The jetty');
  });

  test('Key moments is the default, and illustrates a move at once', async () => {
    const { app, chat } = await setUp();

    await reply(app, chat, movedTo('The jetty'));

    expect(app.settings.illustrationMode()).toBe('key-moments');
    expect(await illustratedReplies(app, chat)).toEqual([1]);
  });

  test('Key moments illustrates a moment worth it, then waits out the cooldown', async () => {
    const { app, chat } = await setUp('key-moments');

    for (let turn = 0; turn < 5; turn += 1) await reply(app, chat, WORTH_IT);

    // A picture at reply 1, then three replies must pass: reply 4.
    expect(await illustratedReplies(app, chat)).toEqual([1, 4]);
  });

  test('Key moments leaves ordinary replies alone', async () => {
    const { app, chat } = await setUp('key-moments');

    await reply(app, chat);
    await reply(app, chat);

    expect(await illustratedReplies(app, chat)).toEqual([]);
  });

  test('the cooldown is a setting', async () => {
    const { app, chat } = await setUp('key-moments');
    app.settings.update({ illustrationCooldown: 1 });

    for (let turn = 0; turn < 3; turn += 1) await reply(app, chat, WORTH_IT);

    expect(await illustratedReplies(app, chat)).toEqual([1, 2, 3]);
  });

  test('a picture asked for restarts the cooldown', async () => {
    const { app, chat } = await setUp('key-moments');
    await reply(app, chat);
    await reply(app, chat);
    await reply(app, chat);
    const first = (await readChat(app, chat.id)).messages.find(
      ({ role }) => role === 'assistant',
    );
    app.provider.scriptStructured(ORDINARY);
    await app.call(
      'POST',
      `/api/chats/${chat.id}/messages/${String(first?.id)}/illustrate`,
    );
    await settled(app, chat);

    await reply(app, chat, WORTH_IT);

    // Without the picture, reply 4 would have been illustrated.
    expect(await illustratedReplies(app, chat)).toEqual([1]);
  });

  test('Scene changes only illustrates moves', async () => {
    const { app, chat } = await setUp('scene-changes');

    await reply(app, chat, WORTH_IT);
    await reply(app, chat, movedTo('The jetty'));
    await reply(app, chat, movedTo('The jetty'));
    await reply(app, chat, movedTo('The kitchen'));

    expect(await illustratedReplies(app, chat)).toEqual([2, 4]);
  });

  test('Every reply illustrates every reply', async () => {
    const { app, chat } = await setUp('every-reply');

    await reply(app, chat);
    await reply(app, chat);

    expect(await illustratedReplies(app, chat)).toEqual([1, 2]);
  });

  test('Off illustrates nothing, but still follows the story', async () => {
    const { app, chat } = await setUp('off');

    await reply(app, chat, movedTo('The jetty'));

    expect(await illustratedReplies(app, chat)).toEqual([]);
    expect(app.jobs.requests).toEqual([]);
    expect(app.provider.structuredRequests).toHaveLength(1);
    expect((await readChat(app, chat.id)).location.name).toBe('The jetty');
  });

  test('the Illustrate button works in Off mode', async () => {
    const { app, chat } = await setUp('off');
    await reply(app, chat);
    const [, answer] = (await readChat(app, chat.id)).messages;

    await app.call(
      'POST',
      `/api/chats/${chat.id}/messages/${String(answer?.id)}/illustrate`,
    );

    expect(await illustratedReplies(app, await settled(app, chat))).toEqual([
      1,
    ]);
  });

  test('a failed scene call is logged, skips that turn, and leaves the reply alone', async () => {
    const { app, chat } = await setUp('every-reply');
    const logged = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const events = await reply(app, chat, {
      fail: new ProviderError('OpenAI is down.'),
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      message: { content: 'Hello.' },
    });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('OpenAI is down.'),
    );
    logged.mockRestore();
    const now = await readChat(app, chat.id);
    expect(now.illustrations).toEqual([]);
    expect(now.illustrating).toEqual([]);

    // The next turn carries on as usual.
    await reply(app, chat);
    expect(await illustratedReplies(app, chat)).toEqual([2]);
  });

  test('a character without a picture is not illustrated by itself', async () => {
    const app = testApp();
    app.settings.update({ illustrationMode: 'every-reply' });
    const chat = await app.startChat();

    await reply(app, chat);

    expect(app.jobs.requests).toEqual([]);
    expect((await readChat(app, chat.id)).illustrating).toEqual([]);
  });

  test('at most one automatic picture waits per chat: a newer one replaces it', async () => {
    const { app, chat } = await setUp('every-reply');
    const finish = app.jobs.holdPainting();

    // The first reply's picture starts and is held; the second waits; the
    // third takes the second's place.
    for (let turn = 0; turn < 3; turn += 1) {
      app.provider.scriptStructured(ORDINARY);
      await replyEvents(
        await app.call('POST', `/api/chats/${chat.id}/messages`, {
          content: 'Go on.',
        }),
      );
      await expect
        .poll(async () => (await readChat(app, chat.id)).followingScene)
        .toBe(false);
    }
    const waiting = (await readChat(app, chat.id)).illustrating;
    expect(waiting.map(({ state }) => state)).toEqual([
      'painting-location',
      'waiting',
    ]);
    finish();

    expect(await illustratedReplies(app, await settled(app, chat))).toEqual([
      1, 3,
    ]);
  });
});
