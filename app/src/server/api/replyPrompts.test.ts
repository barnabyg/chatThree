import { describe, expect, test } from 'vitest';
import type { Chat, ChatSummary, ReplyPrompt } from '../../shared/api.ts';
import { replyEvents, type TestApp, testApp } from '../testing.ts';

const THIRD_PERSON = {
  name: 'Third person',
  prompt: 'Write as a narrator, in the third person, following {character}.',
};

async function list(app: TestApp): Promise<ReplyPrompt[]> {
  return (await (
    await app.call('GET', '/api/reply-prompts')
  ).json()) as ReplyPrompt[];
}

async function create(
  app: TestApp,
  input: object = THIRD_PERSON,
): Promise<ReplyPrompt> {
  const response = await app.call('POST', '/api/reply-prompts', input);
  expect(response.status).toBe(201);
  return (await response.json()) as ReplyPrompt;
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

test('there are none to begin with: every chat uses the default', async () => {
  expect(await list(testApp())).toEqual([]);
});

describe('creating a reply prompt', () => {
  test('saves the name and prompt', async () => {
    const app = testApp();

    const created = await create(app);

    const read = await app.call('GET', `/api/reply-prompts/${created.id}`);
    expect(await read.json()).toEqual({
      ...THIRD_PERSON,
      id: created.id,
      chatCount: 0,
    });
  });

  test('is refused without a name', async () => {
    const response = await testApp().call('POST', '/api/reply-prompts', {
      ...THIRD_PERSON,
      name: ' ',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A reply prompt needs a name.',
    });
  });

  test('is refused without a prompt', async () => {
    const response = await testApp().call('POST', '/api/reply-prompts', {
      name: 'Empty',
      prompt: '\n',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Write the reply prompt.',
    });
  });
});

test('editing a reply prompt changes it', async () => {
  const app = testApp();
  const created = await create(app);

  const response = await app.call('PUT', `/api/reply-prompts/${created.id}`, {
    name: 'Narrator',
    prompt: THIRD_PERSON.prompt,
  });

  expect(response.status).toBe(200);
  expect(await list(app)).toEqual([
    { ...THIRD_PERSON, name: 'Narrator', id: created.id, chatCount: 0 },
  ]);
});

test('an unknown reply prompt is a 404', async () => {
  const response = await testApp().call('GET', '/api/reply-prompts/nope');

  expect(response.status).toBe(404);
});

describe('a chat', () => {
  test('with no reply prompt is told how to reply by the default', async () => {
    const app = testApp();
    const chat = await app.startChat();

    expect(chat.replyPrompt).toBeNull();
    expect(await instructionsAfterAMessage(app, chat)).toMatch(
      /# How to reply\n\nReply only as Mara Quill, in character/,
    );
  });

  test('with a reply prompt is told how to reply by it, with the character named', async () => {
    const app = testApp();
    const { id } = await create(app);
    const chat = await app.startChat({ replyPromptId: id });

    expect(chat.replyPrompt).toEqual({ id, name: THIRD_PERSON.name });
    const instructions = await instructionsAfterAMessage(app, chat);
    expect(instructions).toMatch(
      /# How to reply\n\nWrite as a narrator, in the third person, following Mara Quill\.$/,
    );
    expect(instructions).not.toContain('Reply only as');
  });

  test('cannot be started with a reply prompt that does not exist', async () => {
    const app = testApp();

    const response = await app.call('POST', '/api/chats', {
      characterId: app.characters.list()[0]?.id,
      scenarioId: app.scenarios.list()[0]?.id,
      replyPromptId: 'nope',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'That reply prompt does not exist.',
    });
  });

  test('follows edits to its reply prompt', async () => {
    const app = testApp();
    const { id } = await create(app);
    const chat = await app.startChat({ replyPromptId: id });

    await app.call('PUT', `/api/reply-prompts/${id}`, {
      name: THIRD_PERSON.name,
      prompt: 'Answer in verse.',
    });

    expect(await instructionsAfterAMessage(app, chat)).toMatch(
      /# How to reply\n\nAnswer in verse\.$/,
    );
  });
});

test('deleting a reply prompt puts its chats back on the default, and keeps them', async () => {
  const app = testApp();
  const { id } = await create(app);
  const chat = await app.startChat({ replyPromptId: id });
  expect((await list(app))[0]?.chatCount).toBe(1);

  const response = await app.call('DELETE', `/api/reply-prompts/${id}`);

  expect(response.status).toBe(204);
  expect(await list(app)).toEqual([]);
  const chats = (await (
    await app.call('GET', '/api/chats')
  ).json()) as ChatSummary[];
  expect(chats).toEqual([
    expect.objectContaining({ id: chat.id, replyPrompt: null }),
  ]);
  expect(await instructionsAfterAMessage(app, chat)).toContain(
    'Reply only as Mara Quill',
  );
});
