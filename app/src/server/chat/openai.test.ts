import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  FAKE_API_KEY,
  type FakeOpenAI,
  startFakeOpenAI,
} from '../../../test-support/fake-openai.ts';
import { REASONING_EFFORTS } from '../../shared/api.ts';
import { isChatModel, openAIProvider, supportedEfforts } from './openai.ts';
import {
  ProviderError,
  type ReplyPiece,
  type ReplyRequest,
  type StructuredRequest,
} from './provider.ts';

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

async function collect(stream: AsyncIterable<ReplyPiece>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) {
    pieces.push(typeof piece === 'string' ? piece : '[thinking]');
  }
  return pieces;
}

async function failure(stream: AsyncIterable<ReplyPiece>): Promise<string> {
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
      pieces.push(typeof piece === 'string' ? piece : '[thinking]');
      controller.abort();
    }
  })();

  await expect(reading).rejects.toThrow();
  expect(pieces).toEqual(['one']);
  await expect.poll(() => openai.requests[0]?.abandoned).toBe(true);
});

describe('structured answers', () => {
  function structuredRequest(
    overrides: Partial<StructuredRequest> = {},
  ): StructuredRequest {
    return {
      model: 'scene-model',
      instructions: 'Describe the scene.',
      input: 'Mara: The lamp is lit.',
      schemaName: 'scene',
      schema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
        additionalProperties: false,
      },
      ...overrides,
    };
  }

  async function structuredFailure(answer: Promise<unknown>): Promise<string> {
    try {
      await answer;
    } catch (error) {
      if (error instanceof ProviderError) return error.message;
      throw error;
    }
    throw new Error('expected the request to fail');
  }

  test('returns the JSON the model wrote to the schema', async () => {
    openai.respondToStructuredWith({
      kind: 'json',
      value: { action: 'trimming the lamp' },
    });

    const answer = await provider().structured(structuredRequest());

    expect(answer).toEqual({ action: 'trimming the lamp' });
  });

  test('asks for the schema, without streaming or storing, and apart from replies', async () => {
    await provider().structured(structuredRequest());

    expect(openai.requests).toHaveLength(0);
    expect(openai.structuredRequests[0]).toEqual({
      model: 'scene-model',
      instructions: 'Describe the scene.',
      input: 'Mara: The lamp is lit.',
      stream: false,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'scene',
          strict: true,
          schema: structuredRequest().schema,
        },
      },
    });
  });

  test('says a key is needed when none is set, without calling OpenAI', async () => {
    const message = await structuredFailure(
      provider('').structured(structuredRequest()),
    );

    expect(message).toContain('No OpenAI API key is set');
    expect(openai.structuredRequests).toHaveLength(0);
  });

  test("passes on OpenAI's reason when it rejects the request", async () => {
    openai.respondToStructuredWith({
      kind: 'http-error',
      status: 400,
      message: 'Invalid schema.',
    });

    const message = await structuredFailure(
      provider().structured(structuredRequest()),
    );

    expect(message).toBe('OpenAI returned an error (400): Invalid schema.');
  });

  test('reports a refusal with the reason the model gave', async () => {
    openai.respondToStructuredWith({ kind: 'refusal', text: 'No.' });

    const message = await structuredFailure(
      provider().structured(structuredRequest()),
    );

    expect(message).toBe('The model declined to answer: No.');
  });

  test('reports an answer that is not JSON', async () => {
    openai.respondToStructuredWith({ kind: 'text', text: 'not json' });

    const message = await structuredFailure(
      provider().structured(structuredRequest()),
    );

    expect(message).toBe('OpenAI sent back an answer that is not JSON.');
  });
});

test('sends the thinking level when one is chosen', async () => {
  await collect(
    provider().streamReply(
      request({ model: 'gpt-5.5', reasoningEffort: 'high' }),
    ),
  );

  expect(openai.requests[0]?.body).toMatchObject({
    model: 'gpt-5.5',
    reasoning: { effort: 'high' },
  });
});

test('leaves the thinking level to the model when none is chosen', async () => {
  await collect(provider().streamReply(request()));

  expect(openai.requests[0]?.body).not.toHaveProperty('reasoning');
});

describe('models', () => {
  test('lists only the models that can chat, newest first, without dated snapshots', async () => {
    expect(await provider().models()).toEqual([
      'gpt-5.5',
      'gpt-5-mini',
      'gpt-4.1',
    ]);
  });

  test.each([
    ['gpt-6.2-sol', true],
    ['o3', true],
    ['chat-latest', true],
    ['gpt-5.5-pro', true],
    ['gpt-5.5-2026-04-23', false],
    ['gpt-image-2', false],
    ['chatgpt-image-latest', false],
    ['gpt-4o-mini-tts', false],
    ['gpt-realtime-2', false],
    ['gpt-4o-transcribe', false],
    ['gpt-5-search-api', false],
    ['gpt-5.3-codex', false],
    ['gpt-live-1', false],
    ['gpt-6.1-sol-healthcare', false],
    ['omni-moderation-latest', false],
    ['text-embedding-3-large', false],
    ['whisper-1', false],
  ])('%s is a chat model: %s', (id, chat) => {
    expect(isChatModel(id)).toBe(chat);
  });

  test('says the key was rejected when listing models with a bad key', async () => {
    await expect(provider('sk-wrong').models()).rejects.toThrow(
      'OpenAI rejected the API key. Check the key in Settings.',
    );
  });
});

describe('thinking levels', () => {
  test('are read from the refusal of a level the model does not take', async () => {
    expect(await provider().reasoningEfforts('gpt-5.5')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    // `minimal` was refused at once.
    expect(openai.plainRequests).toHaveLength(1);
  });

  test('try the next level when the model takes the first', async () => {
    expect(await provider().reasoningEfforts('gpt-5-mini')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(
      openai.plainRequests.map(
        (body) => (body.reasoning as { effort: string }).effort,
      ),
    ).toEqual(['minimal', 'max']);
    expect(openai.plainRequests[0]).toMatchObject({
      max_output_tokens: 16,
      store: false,
    });
  });

  test('are none for a model that does not think', async () => {
    expect(await provider().reasoningEfforts('gpt-4.1')).toEqual([]);
  });

  test('are all of them for a model that takes every level', async () => {
    expect(await provider().reasoningEfforts('some-future-model')).toEqual(
      REASONING_EFFORTS,
    );
    expect(openai.plainRequests).toHaveLength(REASONING_EFFORTS.length);
  });

  test('are read from a refusal that names a single level', () => {
    expect(
      supportedEfforts(
        "Unsupported value: 'low' is not supported with the 'chat-latest' model. Supported values are: 'medium'.",
      ),
    ).toEqual(['medium']);
  });
});
