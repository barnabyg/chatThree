import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  FAKE_CONTEXT_LENGTH,
  FAKE_KOBOLDCPP_MODEL,
  type FakeKoboldCpp,
  startFakeKoboldCpp,
} from '../../../test-support/fake-koboldcpp.ts';
import {
  koboldCppAddress,
  koboldCppProvider,
  networkFailure,
} from './koboldcpp.ts';
import { ProviderError, type ReplyRequest } from './provider.ts';

// The provider is tested over real HTTP against a fake KoboldCpp that speaks
// the chat completions streaming format a real one was seen to use.

let kobold: FakeKoboldCpp;
beforeEach(async () => {
  kobold = await startFakeKoboldCpp();
});
afterEach(async () => {
  await kobold.close();
});

function request(overrides: Partial<ReplyRequest> = {}): ReplyRequest {
  return {
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    instructions: 'You are Mara.',
    messages: [{ role: 'user', content: 'Hello?' }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function provider(address: () => string = () => kobold.address) {
  return koboldCppProvider({ address });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) pieces.push(piece);
  return pieces;
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProviderError) return error.message;
    throw error;
  }
  throw new Error('expected a failure');
}

test('streams the reply piece by piece', async () => {
  kobold.respondWith({ kind: 'reply', chunks: ['The lamp', ' is lit.'] });

  const pieces = await collect(provider().streamReply(request()));

  expect(pieces).toEqual(['The lamp', ' is lit.']);
});

test('sends the instructions as a system message, then the conversation, to the loaded model', async () => {
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

  // The OpenAI model and thinking level are not KoboldCpp's to use.
  expect(kobold.requests[0]?.body).toEqual({
    model: FAKE_KOBOLDCPP_MODEL,
    messages: [
      { role: 'system', content: 'You are Mara.' },
      { role: 'user', content: 'Hello?' },
      { role: 'assistant', content: 'Who goes there?' },
      { role: 'user', content: 'A traveller.' },
    ],
    stream: true,
  });
});

test("leaves a thinking model's thoughts out of the reply", async () => {
  kobold.respondWith({
    kind: 'reply',
    reasoning: ['The user wants', ' a greeting.'],
    chunks: ['Evening.'],
  });

  const pieces = await collect(provider().streamReply(request()));

  expect(pieces).toEqual(['Evening.']);
});

test('a reply cut off by a length limit is still the reply', async () => {
  kobold.respondWith({
    kind: 'reply',
    chunks: ['The lamp', ' is'],
    finishReason: 'length',
  });

  const pieces = await collect(provider().streamReply(request()));

  expect(pieces).toEqual(['The lamp', ' is']);
});

test('finds out the loaded model once, and remembers it', async () => {
  const kobolds = provider();

  await collect(kobolds.streamReply(request()));
  await collect(kobolds.streamReply(request()));

  expect(kobold.modelChecks).toBe(1);
  expect(await kobolds.loadedModel()).toEqual({
    id: FAKE_KOBOLDCPP_MODEL,
    contextLength: FAKE_CONTEXT_LENGTH,
  });
  expect(await kobolds.models()).toEqual([FAKE_KOBOLDCPP_MODEL]);
});

test('finds out the loaded model again after a failed request', async () => {
  const kobolds = provider();
  await kobolds.loadedModel();
  kobold.respondWith(
    { kind: 'http-error', status: 503, body: { detail: { msg: 'Busy' } } },
    { kind: 'reply', chunks: ['Back.'] },
  );
  kobold.load('koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M');

  await failure(() => collect(kobolds.streamReply(request())));
  await collect(kobolds.streamReply(request()));

  expect(kobold.requests[1]?.body.model).toBe(
    'koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M',
  );
});

test('finds out the loaded model again when the address changes', async () => {
  const other = await startFakeKoboldCpp();
  other.load('koboldcpp/Other-Q8_0');
  let address = kobold.address;
  const kobolds = provider(() => address);
  try {
    await kobolds.loadedModel();
    address = other.address;

    expect((await kobolds.loadedModel()).id).toBe('koboldcpp/Other-Q8_0');
  } finally {
    await other.close();
  }
});

test('a connection check of the saved address is remembered; of another, not', async () => {
  const kobolds = provider();

  expect(await kobolds.check(kobold.address)).toEqual({
    id: FAKE_KOBOLDCPP_MODEL,
    contextLength: FAKE_CONTEXT_LENGTH,
  });
  await kobolds.loadedModel();
  expect(kobold.modelChecks).toBe(1);

  const other = await startFakeKoboldCpp();
  try {
    await kobolds.check(other.address);
    await kobolds.loadedModel();
    expect(kobold.modelChecks).toBe(1);
  } finally {
    await other.close();
  }
});

test('says so when no model is loaded', async () => {
  kobold.load(undefined);

  expect(await failure(() => provider().loadedModel())).toBe(
    `KoboldCpp at ${kobold.address} has no model loaded.`,
  );
});

test('says so when no address is set', async () => {
  expect(
    await failure(() => collect(provider(() => '').streamReply(request()))),
  ).toBe('No KoboldCpp address is set. Add one in Settings > Connection.');
});

test('names KoboldCpp and its address when it cannot be reached', async () => {
  const address = kobold.address;
  await kobold.close();

  const message = await failure(() =>
    collect(provider(() => address).streamReply(request())),
  );

  expect(message).toMatch(
    new RegExp(
      `^Could not reach KoboldCpp at ${address} \\(.+\\)\\. Check that KoboldCpp is running there`,
    ),
  );
  expect(message).not.toMatch(/OpenAI/);
});

test('suggests the IPv4 address for a .local name that cannot be reached', () => {
  // A real .local lookup can take seconds, so the message is checked alone.
  const timeout = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  });

  const { message } = networkFailure('http://gaming-pc.local:5001', timeout);

  expect(message).toMatch(
    /^Could not reach KoboldCpp at http:\/\/gaming-pc\.local:5001 \(Connect Timeout Error, UND_ERR_CONNECT_TIMEOUT\)\./,
  );
  expect(message).toMatch(/use the PC’s IPv4 address instead/);
});

test("passes on KoboldCpp's own error message, naming KoboldCpp", async () => {
  kobold.respondWith({
    kind: 'http-error',
    status: 500,
    body: { detail: { msg: 'Generation failed', type: 'service_unavailable' } },
  });

  expect(await failure(() => collect(provider().streamReply(request())))).toBe(
    `KoboldCpp at ${kobold.address} returned an error (500): Generation failed`,
  );
});

test('passes on an error that is not JSON', async () => {
  kobold.respondWith({ kind: 'http-error', status: 503, body: 'Server busy' });

  expect(await failure(() => collect(provider().streamReply(request())))).toBe(
    `KoboldCpp at ${kobold.address} returned an error (503): "Server busy"`,
  );
});

test('says a password is not supported when KoboldCpp asks for one', async () => {
  kobold.respondWith({
    kind: 'http-error',
    status: 401,
    body: { error: 'Authentication key is missing or invalid.' },
  });

  expect(await failure(() => collect(provider().streamReply(request())))).toBe(
    `KoboldCpp at ${kobold.address} asks for a password, which chatThree does not send. Start KoboldCpp without --password.`,
  );
});

test('reports a stream that ends early, naming KoboldCpp', async () => {
  kobold.respondWith({ kind: 'disconnect' });

  const message = await failure(() =>
    collect(provider().streamReply(request())),
  );

  expect(message).toMatch(new RegExp(`KoboldCpp at ${kobold.address}`));
  expect(message).not.toMatch(/OpenAI/);
});

test('stopping a reply closes the connection', async () => {
  kobold.respondWith({
    kind: 'reply',
    chunks: ['One', ' two', ' three'],
    holdAfter: 1,
  });
  const controller = new AbortController();
  const pieces: string[] = [];

  await expect(async () => {
    for await (const piece of provider().streamReply(
      request({ signal: controller.signal }),
    )) {
      pieces.push(piece);
      controller.abort();
    }
  }).rejects.toThrow();

  expect(pieces).toEqual(['One']);
  await expect.poll(() => kobold.requests[0]?.abandoned).toBe(true);
});

test('has no thinking levels to choose', async () => {
  expect(await provider().reasoningEfforts(FAKE_KOBOLDCPP_MODEL)).toEqual([]);
});

test.each([
  ['http://192.168.1.50:5001', 'http://192.168.1.50:5001'],
  ['  http://192.168.1.50:5001/  ', 'http://192.168.1.50:5001'],
  ['192.168.1.50:5001', 'http://192.168.1.50:5001'],
  ['https://kobold.example:443', 'https://kobold.example'],
  ['HTTP://Gaming-PC:5001', 'http://gaming-pc:5001'],
  ['', ''],
])('reads %j as the address %j', (typed, address) => {
  expect(koboldCppAddress(typed)).toBe(address);
});

test.each([
  'http://192.168.1.50:5001/v1',
  'ftp://192.168.1.50',
  'http://user:secret@192.168.1.50:5001',
  'http://192.168.1.50:5001?x=1',
  'http://',
])('refuses %j as an address', (typed) => {
  expect(koboldCppAddress(typed)).toBeUndefined();
});
