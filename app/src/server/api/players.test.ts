import { describe, expect, test } from 'vitest';
import type { Chat, Player } from '../../shared/api.ts';
import { readReply, replyEvents, type TestApp, testApp } from '../testing.ts';

const BOB = {
  name: 'Bob',
  background: 'A retired lock-keeper who knows every eddy of the river.',
};

async function list(app: TestApp): Promise<Player[]> {
  return (await (await app.call('GET', '/api/players')).json()) as Player[];
}

async function create(app: TestApp, input: object = BOB): Promise<Player> {
  const response = await app.call('POST', '/api/players', input);
  expect(response.status).toBe(201);
  return (await response.json()) as Player;
}

async function instructionsAfterAMessage(
  app: TestApp,
  chat: Chat,
): Promise<string> {
  await replyEvents(
    await app.call('POST', `/api/chats/${chat.id}/messages`, {
      content: 'Hello?',
    }),
  );
  return app.provider.requests.at(-1)?.instructions ?? '';
}

test("the built-in scenario's traveller is there to begin with, as an ordinary player", async () => {
  const app = testApp();

  expect(await list(app)).toEqual([
    {
      id: expect.any(String) as string,
      name: 'The Traveller',
      background: expect.stringContaining('tin box') as string,
      chatCount: 0,
    },
  ]);
});

describe('creating a player', () => {
  test('saves the name and background', async () => {
    const app = testApp();

    const created = await create(app);

    const read = await app.call('GET', `/api/players/${created.id}`);
    expect(await read.json()).toEqual({ ...BOB, id: created.id, chatCount: 0 });
  });

  test('needs only a name', async () => {
    const created = await create(testApp(), { name: 'Bob' });

    expect(created).toMatchObject({ name: 'Bob', background: '' });
  });

  test('is refused without a name', async () => {
    const app = testApp();

    const response = await app.call('POST', '/api/players', {
      ...BOB,
      name: ' ',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A player needs a name.' });
  });
});

test('editing a player changes it', async () => {
  const app = testApp();
  const created = await create(app);

  const response = await app.call('PUT', `/api/players/${created.id}`, {
    name: 'Robert',
    background: BOB.background,
  });

  expect(await response.json()).toMatchObject({
    id: created.id,
    name: 'Robert',
  });
});

test('an unknown player is a 404', async () => {
  const response = await testApp().call('GET', '/api/players/no-such-id');

  expect(response.status).toBe(404);
});

describe('a chat', () => {
  test("played as a player carries their name and background in the prompt, as the user's part", async () => {
    const app = testApp();
    const bob = await create(app);

    const chat = await app.startChat({ playerId: bob.id });

    expect(chat.player).toEqual({ id: bob.id, name: 'Bob' });
    const instructions = await instructionsAfterAMessage(app, chat);
    expect(instructions).toContain(
      `## The part the user plays\nBob\n${BOB.background}`,
    );
  });

  test('played as no one has no part for the user in the prompt', async () => {
    const app = testApp();

    const chat = await app.startChat();

    expect(chat.player).toBeNull();
    expect(await instructionsAfterAMessage(app, chat)).not.toContain(
      'The part the user plays',
    );
  });

  test('cannot be started as a player that does not exist', async () => {
    const app = testApp();

    const response = await app.call('POST', '/api/chats', {
      characterId: app.characters.list()[0]?.id,
      scenarioId: app.scenarios.list()[0]?.id,
      playerId: 'no-such-player',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'That player does not exist.',
    });
  });

  test("follows edits to its player's background", async () => {
    const app = testApp();
    const bob = await create(app);
    const chat = await app.startChat({ playerId: bob.id });

    await app.call('PUT', `/api/players/${bob.id}`, {
      name: 'Bob',
      background: 'A smuggler, in truth.',
    });

    expect(await instructionsAfterAMessage(app, chat)).toContain(
      'A smuggler, in truth.',
    );
  });
});

describe('deleting a player', () => {
  test('counts their chats, deletes them with it, and leaves other chats alone', async () => {
    const app = testApp();
    const bob = await create(app);
    const kept = await app.startChat();
    const lost = await app.startChat({ playerId: bob.id });
    expect((await list(app)).find(({ id }) => id === bob.id)?.chatCount).toBe(
      1,
    );

    const response = await app.call('DELETE', `/api/players/${bob.id}`);

    expect(response.status).toBe(204);
    expect((await app.call('GET', `/api/chats/${lost.id}`)).status).toBe(404);
    expect((await app.call('GET', `/api/chats/${kept.id}`)).status).toBe(200);
    expect((await list(app)).map(({ name }) => name)).toEqual([
      'The Traveller',
    ]);
  });

  test('is refused while a reply is being written in one of their chats', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['In'], thenWait: true });
    const bob = await create(app);
    const chat = await app.startChat({ playerId: bob.id });
    const reply = readReply(
      await app.call('POST', `/api/chats/${chat.id}/messages`, {
        content: 'Hello?',
      }),
    );
    await reply.next();

    const response = await app.call('DELETE', `/api/players/${bob.id}`);

    expect(response.status).toBe(409);
    await app.call('POST', `/api/chats/${chat.id}/stop`);
    await reply.next();
    await reply.next();
  });
});
