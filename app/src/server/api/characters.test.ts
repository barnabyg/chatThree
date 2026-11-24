import { describe, expect, test } from 'vitest';
import type { Character, Chat } from '../../shared/api.ts';
import { readReply, replyEvents, type TestApp, testApp } from '../testing.ts';

const TOMAS = {
  name: 'Tomas Reed',
  persona: 'A ferryman who has never left the river.',
  speakingStyle: 'Slow, with long pauses.',
  exampleDialogue: 'User: Can you take me across?\nTomas: In time.',
  appearance: 'Tall, in a patched coat.',
};

async function list(app: TestApp): Promise<Character[]> {
  return (await (
    await app.call('GET', '/api/characters')
  ).json()) as Character[];
}

async function create(app: TestApp, input: object = TOMAS): Promise<Character> {
  const response = await app.call('POST', '/api/characters', input);
  expect(response.status).toBe(201);
  return (await response.json()) as Character;
}

function chatWith(app: TestApp, character: Character): Promise<Chat> {
  return app.startChat({ characterId: character.id });
}

test('the built-in character is there to begin with, as an ordinary character', async () => {
  const app = testApp();

  const [builtIn, ...others] = await list(app);

  expect(others).toEqual([]);
  expect(builtIn).toMatchObject({ name: 'Mara Quill', chatCount: 0 });
  expect(builtIn?.persona).not.toBe('');

  const edited = await app.call('PUT', `/api/characters/${builtIn?.id ?? ''}`, {
    persona: builtIn?.persona,
    speakingStyle: builtIn?.speakingStyle,
    exampleDialogue: builtIn?.exampleDialogue,
    appearance: builtIn?.appearance,
    name: 'Mara the Keeper',
  });
  expect(edited.status).toBe(200);
  expect((await list(app)).map(({ name }) => name)).toEqual([
    'Mara the Keeper',
  ]);
});

describe('creating a character', () => {
  test('saves every field', async () => {
    const app = testApp();

    const created = await create(app);

    expect(created).toMatchObject(TOMAS);
    const read = await app.call('GET', `/api/characters/${created.id}`);
    expect(await read.json()).toEqual({
      ...TOMAS,
      id: created.id,
      chatCount: 0,
      hasVoice: false,
    });
  });

  test('needs only a name', async () => {
    const app = testApp();

    const created = await create(app, { name: 'Nameless Stranger' });

    expect(created).toMatchObject({
      name: 'Nameless Stranger',
      persona: '',
      speakingStyle: '',
      exampleDialogue: '',
      appearance: '',
    });
  });

  test('is refused without a name', async () => {
    const app = testApp();

    const response = await app.call('POST', '/api/characters', {
      ...TOMAS,
      name: '  ',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A character needs a name.',
    });
    expect(await list(app)).toHaveLength(1);
  });
});

test('editing a character changes it', async () => {
  const app = testApp();
  const created = await create(app);

  const response = await app.call('PUT', `/api/characters/${created.id}`, {
    ...TOMAS,
    persona: 'A ferryman who dreams of the sea.',
  });

  expect(await response.json()).toMatchObject({
    id: created.id,
    persona: 'A ferryman who dreams of the sea.',
  });
});

test('an unknown character is a 404', async () => {
  const response = await testApp().call('GET', '/api/characters/no-such-id');

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: 'That character does not exist.',
  });
});

describe('chatting with a character', () => {
  test('a chat is with the character it was started with', async () => {
    const app = testApp();
    const tomas = await create(app);

    const chat = await chatWith(app, tomas);

    expect(chat.character).toEqual({ id: tomas.id, name: 'Tomas Reed' });
    expect((await list(app)).find(({ id }) => id === tomas.id)?.chatCount).toBe(
      1,
    );
  });

  test("the prompt carries the character's persona, speaking style and example dialogue, but not the appearance", async () => {
    const app = testApp();
    const chat = await chatWith(app, await create(app));

    await replyEvents(
      await app.call('POST', `/api/chats/${chat.id}/messages`, {
        content: 'Hello?',
      }),
    );

    const instructions = app.provider.requests[0]?.instructions ?? '';
    expect(instructions).toContain('# Character: Tomas Reed');
    expect(instructions).toContain(TOMAS.persona);
    expect(instructions).toContain(TOMAS.speakingStyle);
    expect(instructions).toContain(TOMAS.exampleDialogue);
    expect(instructions).not.toContain(TOMAS.appearance);
    expect(instructions).not.toContain('Mara Quill');
  });
});

describe('deleting a character', () => {
  test('removes it', async () => {
    const app = testApp();
    const tomas = await create(app);

    const response = await app.call('DELETE', `/api/characters/${tomas.id}`);

    expect(response.status).toBe(204);
    expect((await list(app)).map(({ name }) => name)).toEqual(['Mara Quill']);
  });

  test('deletes its chats with it, and leaves other chats alone', async () => {
    const app = testApp();
    const [mara] = await list(app);
    if (mara === undefined) throw new Error('expected the built-in character');
    const tomas = await create(app);
    const kept = await chatWith(app, mara);
    const lost = await chatWith(app, tomas);

    await app.call('DELETE', `/api/characters/${tomas.id}`);

    expect((await app.call('GET', `/api/chats/${lost.id}`)).status).toBe(404);
    expect((await app.call('GET', `/api/chats/${kept.id}`)).status).toBe(200);
  });

  test('is refused while a reply is being written in one of its chats', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['In'], thenWait: true });
    const tomas = await create(app);
    const chat = await chatWith(app, tomas);
    const reply = readReply(
      await app.call('POST', `/api/chats/${chat.id}/messages`, {
        content: 'Hello?',
      }),
    );
    await reply.next();

    const response = await app.call('DELETE', `/api/characters/${tomas.id}`);

    expect(response.status).toBe(409);
    await app.call('POST', `/api/chats/${chat.id}/stop`);
    await reply.next();
    await reply.next();
  });
});
