import { describe, expect, test } from 'vitest';
import type { Chat, ChatSummary } from '../../shared/api.ts';
import { ProviderError } from '../chat/provider.ts';
import { readReply, replyEvents, type TestApp, testApp } from '../testing.ts';

async function newChat(app: TestApp): Promise<Chat> {
  return (await (await app.call('POST', '/api/chats')).json()) as Chat;
}

async function readChat(app: TestApp, id: string): Promise<Chat> {
  return (await (await app.call('GET', `/api/chats/${id}`)).json()) as Chat;
}

function send(app: TestApp, chat: Chat, content: string): Promise<Response> {
  return app.call('POST', `/api/chats/${chat.id}/messages`, { content });
}

function turns(chat: Chat): [string, string][] {
  return chat.messages.map(({ role, content }) => [role, content]);
}

describe('starting a chat', () => {
  test('a new chat is with the built-in character in the built-in scenario, and empty', async () => {
    const app = testApp();

    const chat = await newChat(app);

    expect(chat).toMatchObject({
      character: { name: 'Mara Quill' },
      scenario: { title: 'The Storm at Gull Point' },
      messages: [],
      replying: false,
    });
  });

  test('a chat that was started is listed', async () => {
    const app = testApp();
    const chat = await newChat(app);

    const list = (await (
      await app.call('GET', '/api/chats')
    ).json()) as ChatSummary[];

    expect(list.map(({ id }) => id)).toEqual([chat.id]);
  });

  test('an unknown chat is a 404 with a message', async () => {
    const response = await testApp().call('GET', '/api/chats/no-such-chat');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'That chat does not exist.',
    });
  });
});

describe('sending a message', () => {
  test('streams the saved message, the reply piece by piece, then the saved reply', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['Who goes', ' there?'] });
    const chat = await newChat(app);

    const events = await replyEvents(await send(app, chat, 'Hello?'));

    expect(events).toMatchObject([
      { type: 'user-message', message: { role: 'user', content: 'Hello?' } },
      { type: 'delta', text: 'Who goes' },
      { type: 'delta', text: ' there?' },
      {
        type: 'done',
        message: { role: 'assistant', content: 'Who goes there?' },
      },
    ]);
  });

  test('the conversation is saved', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['Who goes there?'] });
    const chat = await newChat(app);

    await replyEvents(await send(app, chat, 'Hello?'));

    expect(turns(await readChat(app, chat.id))).toEqual([
      ['user', 'Hello?'],
      ['assistant', 'Who goes there?'],
    ]);
  });

  test('the provider is given the character, then the scenario, then the whole conversation', async () => {
    const app = testApp();
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));

    await replyEvents(await send(app, chat, 'A traveller.'));

    const [first, second] = app.provider.requests;
    expect(second?.instructions).toBe(first?.instructions);
    expect(second?.instructions.indexOf('Mara Quill')).toBeLessThan(
      second?.instructions.indexOf('The Storm at Gull Point') ?? -1,
    );
    expect(second?.messages).toEqual([
      { role: 'user', content: 'Hello?' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'A traveller.' },
    ]);
  });

  test('the model named in settings is the one asked', async () => {
    const app = testApp();
    app.settings.update({ model: 'another-model' });
    const chat = await newChat(app);

    await replyEvents(await send(app, chat, 'Hello?'));

    expect(app.provider.requests[0]?.model).toBe('another-model');
  });

  test('an empty message is refused', async () => {
    const app = testApp();
    const chat = await newChat(app);

    const response = await send(app, chat, '   ');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Type a message first.' });
    expect((await readChat(app, chat.id)).messages).toEqual([]);
  });
});

describe('when no reply can be produced', () => {
  test("the provider's reason is reported and the user's message is kept", async () => {
    const app = testApp();
    app.provider.script({
      pieces: [],
      thenFail: new ProviderError('OpenAI rejected the API key.'),
    });
    const chat = await newChat(app);

    const events = await replyEvents(await send(app, chat, 'Hello?'));

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'OpenAI rejected the API key.',
    });
    expect(turns(await readChat(app, chat.id))).toEqual([['user', 'Hello?']]);
  });

  test('a reply that fails part-way is not saved', async () => {
    const app = testApp();
    app.provider.script({
      pieces: ['Who goes'],
      thenFail: new ProviderError('Could not reach OpenAI.'),
    });
    const chat = await newChat(app);

    await replyEvents(await send(app, chat, 'Hello?'));

    expect(turns(await readChat(app, chat.id))).toEqual([['user', 'Hello?']]);
  });

  test('a later message can still be sent', async () => {
    const app = testApp();
    app.provider.script({
      pieces: [],
      thenFail: new ProviderError('Could not reach OpenAI.'),
    });
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));

    const events = await replyEvents(await send(app, chat, 'Anyone?'));

    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('stopping a reply', () => {
  test('ends the reply and keeps what had been written', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['Who goes'], thenWait: true });
    const chat = await newChat(app);
    const reply = readReply(await send(app, chat, 'Hello?'));
    await reply.next(); // the saved user message
    await reply.next(); // the first piece

    const stopped = await app.call('POST', `/api/chats/${chat.id}/stop`);
    const last = await reply.next();

    expect(stopped.status).toBe(204);
    expect(last.value).toMatchObject({
      type: 'done',
      message: { role: 'assistant', content: 'Who goes' },
    });
    expect(turns(await readChat(app, chat.id))).toEqual([
      ['user', 'Hello?'],
      ['assistant', 'Who goes'],
    ]);
  });

  test('a reply stopped before any text arrives leaves no reply', async () => {
    const app = testApp();
    app.provider.script({ pieces: [], thenWait: true });
    const chat = await newChat(app);
    const reply = readReply(await send(app, chat, 'Hello?'));
    await reply.next(); // the saved user message

    await app.call('POST', `/api/chats/${chat.id}/stop`);

    expect((await reply.next()).value).toEqual({ type: 'done', message: null });
    expect(turns(await readChat(app, chat.id))).toEqual([['user', 'Hello?']]);
  });

  test('while a reply is being written the chat says so and takes no other message', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['Who goes'], thenWait: true });
    const chat = await newChat(app);
    const reply = readReply(await send(app, chat, 'Hello?'));
    await reply.next();

    const second = await send(app, chat, 'Hello again?');

    expect(second.status).toBe(409);
    expect((await readChat(app, chat.id)).replying).toBe(true);

    await app.call('POST', `/api/chats/${chat.id}/stop`);
    await reply.next();
    await reply.next();
    expect((await readChat(app, chat.id)).replying).toBe(false);
  });
});

function regenerate(app: TestApp, chat: Chat): Promise<Response> {
  return app.call('POST', `/api/chats/${chat.id}/regenerate`);
}

function deleteLast(app: TestApp, chat: Chat): Promise<Response> {
  return app.call('DELETE', `/api/chats/${chat.id}/messages/last`);
}

describe('regenerating the last reply', () => {
  test('replaces it with a new reply to the same conversation', async () => {
    const app = testApp();
    app.provider.script(
      { pieces: ['First answer.'] },
      { pieces: ['Second', ' answer.'] },
    );
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));

    const events = await replyEvents(await regenerate(app, chat));

    expect(events).toMatchObject([
      { type: 'delta', text: 'Second' },
      { type: 'delta', text: ' answer.' },
      {
        type: 'done',
        message: { role: 'assistant', content: 'Second answer.' },
      },
    ]);
    expect(turns(await readChat(app, chat.id))).toEqual([
      ['user', 'Hello?'],
      ['assistant', 'Second answer.'],
    ]);
    expect(app.provider.requests[1]?.messages).toEqual(
      app.provider.requests[0]?.messages,
    );
  });

  test('keeps the old reply when the new one fails', async () => {
    const app = testApp();
    app.provider.script(
      { pieces: ['First answer.'] },
      {
        pieces: ['Sec'],
        thenFail: new ProviderError('Could not reach OpenAI.'),
      },
    );
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));

    const events = await replyEvents(await regenerate(app, chat));

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Could not reach OpenAI.',
    });
    expect(turns(await readChat(app, chat.id))).toEqual([
      ['user', 'Hello?'],
      ['assistant', 'First answer.'],
    ]);
  });

  test("writes the missing reply when the last message is the user's", async () => {
    const app = testApp();
    app.provider.script(
      { pieces: [], thenFail: new ProviderError('Could not reach OpenAI.') },
      { pieces: ['Here now.'] },
    );
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));

    await replyEvents(await regenerate(app, chat));

    expect(turns(await readChat(app, chat.id))).toEqual([
      ['user', 'Hello?'],
      ['assistant', 'Here now.'],
    ]);
  });

  test('is refused in a chat with nothing to reply to', async () => {
    const app = testApp();
    const chat = await newChat(app);

    const response = await regenerate(app, chat);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'There is no message to reply to yet.',
    });
  });
});

describe('deleting the last message', () => {
  test('removes only the last message, and the change is saved', async () => {
    const app = testApp();
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));

    const response = await deleteLast(app, chat);

    expect(turns((await response.json()) as Chat)).toEqual([
      ['user', 'Hello?'],
    ]);
    expect(turns(await readChat(app, chat.id))).toEqual([['user', 'Hello?']]);
  });

  test("removes the user's message when that is the last one", async () => {
    const app = testApp();
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, 'Hello?'));
    await deleteLast(app, chat);

    await deleteLast(app, chat);

    expect((await readChat(app, chat.id)).messages).toEqual([]);
  });

  test('is refused in an empty chat', async () => {
    const app = testApp();
    const chat = await newChat(app);

    const response = await deleteLast(app, chat);

    expect(response.status).toBe(400);
  });
});

test('while a reply is being written, the last reply can be neither regenerated nor deleted', async () => {
  const app = testApp();
  app.provider.script({ pieces: ['Who goes'], thenWait: true });
  const chat = await newChat(app);
  const reply = readReply(await send(app, chat, 'Hello?'));
  await reply.next();

  const responses = [await regenerate(app, chat), await deleteLast(app, chat)];

  expect(responses.map(({ status }) => status)).toEqual([409, 409]);
  await app.call('POST', `/api/chats/${chat.id}/stop`);
  await reply.next();
  await reply.next();
  expect(turns(await readChat(app, chat.id))).toEqual([
    ['user', 'Hello?'],
    ['assistant', 'Who goes'],
  ]);
});

describe('a chat longer than the token budget', () => {
  // Estimated at 53 tokens: 196 characters / 4, plus 4.
  const long = (label: string): string => label.padEnd(196, '.');

  test('sends only the newest messages that fit, after the same instructions, and keeps them all', async () => {
    const app = testApp();
    // Room for two long messages (106 tokens) but not three.
    app.settings.update({ contextTokenBudget: 110 });
    app.provider.script(
      { pieces: [long('reply one')] },
      { pieces: [long('reply two')] },
    );
    const chat = await newChat(app);
    await replyEvents(await send(app, chat, long('message one')));
    await replyEvents(await send(app, chat, long('message two')));

    await replyEvents(await send(app, chat, long('message three')));

    const [first, , third] = app.provider.requests;
    expect(third?.messages).toEqual([
      { role: 'assistant', content: long('reply two') },
      { role: 'user', content: long('message three') },
    ]);
    expect(third?.instructions).toBe(first?.instructions);

    // The short last reply (6 tokens) and the message before it are what
    // would be sent next: the four before them are not.
    const saved = await readChat(app, chat.id);
    expect(saved.messages).toHaveLength(6);
    expect(saved.notSent).toBe(4);
  });

  test('a chat within the budget has every message sent', async () => {
    const app = testApp();
    const chat = await newChat(app);

    await replyEvents(await send(app, chat, long('message one')));

    expect((await readChat(app, chat.id)).notSent).toBe(0);
  });
});
