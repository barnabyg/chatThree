import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  FAKE_API_KEY,
  type FakeOpenAI,
  startFakeOpenAI,
} from '../../../test-support/fake-openai.ts';
import { openAIProvider } from './openai.ts';
import { ProviderError, type ReplyRequest } from './provider.ts';

// The provider is tested over real HTTP against a fake OpenAI server that
// speaks the Responses API's streaming format.

let openai: FakeOpenAI;
beforeEach(async () => {
  openai = await startFakeOpenAI();
});
afterEach(async () => {
  await openai.close();
});

function request(overrides: Partial<ReplyRequest> = {}): ReplyRequest {
  return {
    model: 'test-model',
    instructions: 'You are Mara.',
    messages: [{ role: 'user', content: 'Hello?' }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function provider(apiKey: string | undefined = FAKE_API_KEY) {
  return openAIProvider({ baseUrl: openai.baseUrl, apiKey: () => apiKey });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) pieces.push(piece);
  return pieces;
}

async function failure(stream: AsyncIterable<string>): Promise<string> {
  try {
    await collect(stream);
  } catch (error) {
    if (error instanceof ProviderError) return error.message;
    throw error;
  }
  throw new Error('expected the reply to fail');
}

test('streams the reply piece by piece', async () => {
  openai.respondWith({ kind: 'reply', chunks: ['The lamp', ' is lit.'] });

  const pieces = await collect(provider().streamReply(request()));

  expect(pieces).toEqual(['The lamp', ' is lit.']);
});

test('sends the instructions, the conversation and the model, without storing the response', async () => {
  await collect(
    provider().streamReply(
      request({
        messages: [
          { role: 'user', content: 'Hello?' },
          { role: 'assistant', content: 'Who goes there?' },
          { role: 'user', content: 'A traveller.' },
        ],
      }),
    ),
  );

  expect(openai.requests[0]?.body).toEqual({
    model: 'test-model',
    instructions: 'You are Mara.',
    input: [
      { role: 'user', content: 'Hello?' },
      { role: 'assistant', content: 'Who goes there?' },
      { role: 'user', content: 'A traveller.' },
    ],
    stream: true,
    store: false,
  });
});

test('says a key is needed when none is set, without calling OpenAI', async () => {
  const message = await failure(provider('').streamReply(request()));

  expect(message).toContain('No OpenAI API key is set');
  expect(openai.requests).toHaveLength(0);
});

test('says the key was rejected when it is invalid, without repeating it', async () => {
  const message = await failure(
    provider('sk-wrong-key').streamReply(request()),
  );

  expect(message).toBe(
    'OpenAI rejected the API key. Check the key in Settings.',
  );
});

test.each([
  ['a line break', 'sk-test\n-0000'],
  ['a space', 'sk-test -0000'],
  ['an invisible character', 'sk-test\u200B-0000'],
])(
  'a key containing %s is reported as malformed, without repeating it or calling OpenAI',
  async (_what, key) => {
    const message = await failure(provider(key).streamReply(request()));

    expect(message).toContain('is not a valid key');
    expect(message).not.toContain('sk-test');
    expect(openai.requests).toHaveLength(0);
  },
);

test("passes on OpenAI's reason when it rejects the request", async () => {
  openai.respondWith({
    kind: 'http-error',
    status: 404,
    message: 'The model `test-model` does not exist.',
  });

  const message = await failure(provider().streamReply(request()));

  expect(message).toBe(
    'OpenAI returned an error (404): The model `test-model` does not exist.',
  );
});

test('reports a refusal with the reason the model gave', async () => {
  openai.respondWith({ kind: 'refusal', text: "I can't help with that." });

  const message = await failure(provider().streamReply(request()));

  expect(message).toBe("The model declined to reply: I can't help with that.");
});

test('reports a network failure when the connection drops mid-reply', async () => {
  openai.respondWith({ kind: 'disconnect' });

  const message = await failure(provider().streamReply(request()));

  expect(message).toContain('Could not reach OpenAI');
});

test('reports a network failure when OpenAI cannot be reached at all', async () => {
  await openai.close();

  const message = await failure(provider().streamReply(request()));

  expect(message).toContain('Could not reach OpenAI');
});

test('stops asking OpenAI for more when the reply is aborted', async () => {
  openai.respondWith({
    kind: 'reply',
    chunks: ['one', 'two', 'three', 'four'],
    chunkDelayMs: 50,
  });
  const controller = new AbortController();
  const pieces: string[] = [];

  const reading = (async () => {
    for await (const piece of provider().streamReply(
      request({ signal: controller.signal }),
    )) {
      pieces.push(piece);
      controller.abort();
    }
  })();

  await expect(reading).rejects.toThrow();
  expect(pieces).toEqual(['one']);
  await expect.poll(() => openai.requests[0]?.abandoned).toBe(true);
});
