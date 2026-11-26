import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  FAKE_CONTEXT_LENGTH,
  FAKE_KOBOLDCPP_MODEL,
  type FakeKoboldCpp,
  KOBOLD_SCENE,
  startFakeKoboldCpp,
} from '../../../test-support/fake-koboldcpp.ts';
import {
  koboldCppAddress,
  koboldCppProvider,
  networkFailure,
} from './koboldcpp.ts';
import { SCENE_SCHEMA } from '../scene/describe.ts';
import { type ModelProfile, presetFor } from './profiles.ts';
import {
  ProviderError,
  type ReplyPiece,
  type ReplyRequest,
} from './provider.ts';

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

/** The pieces of a reply, with `[thinking]` where the model began to think. */
async function collect(stream: AsyncIterable<ReplyPiece>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) {
    pieces.push(typeof piece === 'string' ? piece : '[thinking]');
  }
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
  const body = kobold.requests[0]?.body;
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(body).toMatchObject({
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

  expect(pieces).toEqual(['[thinking]', 'Evening.']);
});

describe('thinking', () => {
  const QWEN = 'koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M';

  test('a reply after separate thinking starts without its blank lines', async () => {
    kobold.load(QWEN);
    kobold.respondWith({
      kind: 'reply',
      reasoning: ['Hmm.'],
      chunks: ['\n\n', '"Come in."'],
    });

    const pieces = await collect(provider().streamReply(request()));

    expect(pieces).toEqual(['[thinking]', '"Come in."']);
  });

  test('thinking between tags in the content is dropped, for a model whose profile strips it', async () => {
    kobold.load(QWEN);
    kobold.respondWith({
      kind: 'reply',
      chunks: ['<thi', 'nk>The user', ' knocks.</th', 'ink>\n\nCome', ' in.'],
    });

    const pieces = await collect(provider().streamReply(request()));

    expect(pieces).toEqual(['[thinking]', 'Come', ' in.']);
  });

  test('a reply that is all thinking, cut off, has no text', async () => {
    kobold.load(QWEN);
    kobold.respondWith({
      kind: 'reply',
      chunks: ['<think>The user', ' knocks and'],
      finishReason: 'length',
    });

    const pieces = await collect(provider().streamReply(request()));

    expect(pieces).toEqual(['[thinking]']);
  });

  test('a model whose profile has no thinking streams its content unchanged, tags and all', async () => {
    kobold.respondWith({
      kind: 'reply',
      chunks: ['<think>x</think>', ' Hello.'],
    });

    const pieces = await collect(provider().streamReply(request()));

    expect(pieces).toEqual(['<think>x</think>', ' Hello.']);
  });

  test('a scene answer cut off mid-thought is asked for again, and a thought before the JSON is dropped', async () => {
    kobold.load(QWEN);
    kobold.answerWith(
      { kind: 'text', text: '<think>\nThe user keep' },
      {
        kind: 'text',
        text: `<think>Plan it.</think>
${JSON.stringify(KOBOLD_SCENE)}`,
      },
    );

    const scene = await provider().structured({
      model: 'gpt-5.5',
      instructions: 'Describe the scene.',
      input: 'Mara looks out.',
      schemaName: 'scene',
      schema: SCENE_SCHEMA,
    });

    expect(scene).toEqual(KOBOLD_SCENE);
    expect(kobold.structuredRequests).toHaveLength(2);
  });
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
      pieces.push(typeof piece === 'string' ? piece : '[thinking]');
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

describe('the scene call', () => {
  const SCENE_REQUEST = {
    model: 'gpt-5-mini',
    instructions: 'Describe the moment.',
    input: 'Mara: Come in.',
    schemaName: 'scene',
    schema: SCENE_SCHEMA,
  };

  test('holds KoboldCpp to the schema, describes the fields too, and gets a good answer', async () => {
    const answer = await provider().structured(SCENE_REQUEST);

    expect(answer).toEqual(KOBOLD_SCENE);
    expect(kobold.structuredRequests).toHaveLength(1);
    const [body] = kobold.structuredRequests;
    expect(body).toMatchObject({
      model: FAKE_KOBOLDCPP_MODEL,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'scene', strict: true, schema: SCENE_SCHEMA },
      },
    });
    const [system, user] = body?.messages as {
      role: string;
      content: string;
    }[];
    expect(system?.role).toBe('system');
    expect(system?.content).toMatch(/^Describe the moment\.\n\n/);
    expect(system?.content).toContain('- action (text): What the character');
    expect(user).toEqual({ role: 'user', content: 'Mara: Come in.' });
  });

  test.each([
    ['in prose', `Here you go:\n${JSON.stringify(KOBOLD_SCENE)}\nEnjoy.`],
    ['in a code fence', `\`\`\`json\n${JSON.stringify(KOBOLD_SCENE)}\n\`\`\``],
    [
      'after a thinking block',
      `<think>\nA quiet moment.\n</think>\n\n${JSON.stringify(KOBOLD_SCENE)}`,
    ],
  ])('finds an answer %s', async (_where, text) => {
    kobold.answerWith({ kind: 'text', text });

    expect(await provider().structured(SCENE_REQUEST)).toEqual(KOBOLD_SCENE);
    expect(kobold.structuredRequests).toHaveLength(1);
  });

  test('asks once more, with what was wrong, when the answer does not follow the schema', async () => {
    const missing: Partial<typeof KOBOLD_SCENE> = { ...KOBOLD_SCENE };
    delete missing.worthIllustrating;
    kobold.answerWith(
      { kind: 'text', text: JSON.stringify({ ...missing, moved: 'no' }) },
      { kind: 'text', text: JSON.stringify(KOBOLD_SCENE) },
    );

    expect(await provider().structured(SCENE_REQUEST)).toEqual(KOBOLD_SCENE);

    expect(kobold.structuredRequests).toHaveLength(2);
    const retry = kobold.structuredRequests[1];
    expect(retry?.response_format).toBeUndefined();
    const messages = retry?.messages as { role: string; content: string }[];
    expect(messages.map(({ role }) => role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]?.content).toContain('Answer with only the JSON object');
    expect(messages[3]?.content).toBe(
      'That answer could not be used: worthIllustrating is missing; moved should be a boolean, not a string. Answer again with only the JSON object, with every field.',
    );
  });

  test('fails, naming KoboldCpp, when the second answer does not follow the schema either', async () => {
    kobold.answerWith({ kind: 'text', text: 'A quiet moment by the stove.' });

    expect(await failure(() => provider().structured(SCENE_REQUEST))).toBe(
      `KoboldCpp at ${kobold.address} answered in a form chatThree could not use (the answer is not a JSON object). Try again.`,
    );
    expect(kobold.structuredRequests).toHaveLength(2);
  });

  test('asks for the JSON in words when KoboldCpp refuses to be held to the schema', async () => {
    kobold.answerWith(
      {
        kind: 'http-error',
        status: 400,
        body: { detail: { msg: 'Unsupported response_format' } },
      },
      { kind: 'text', text: JSON.stringify(KOBOLD_SCENE) },
    );

    expect(await provider().structured(SCENE_REQUEST)).toEqual(KOBOLD_SCENE);

    const asked = kobold.structuredRequests[1];
    expect(asked?.response_format).toBeUndefined();
    const [system] = asked?.messages as { content: string }[];
    expect(system?.content).toContain('"worthIllustrating": false');
  });

  test('passes on any other error at once', async () => {
    kobold.answerWith({
      kind: 'http-error',
      status: 500,
      body: { detail: { msg: 'Out of memory' } },
    });

    expect(await failure(() => provider().structured(SCENE_REQUEST))).toBe(
      `KoboldCpp at ${kobold.address} returned an error (500): Out of memory`,
    );
    expect(kobold.structuredRequests).toHaveLength(1);
  });
});

describe('model profiles', () => {
  const GEMMA = presetFor(FAKE_KOBOLDCPP_MODEL).profile;

  function profiled(change: Partial<ModelProfile>) {
    return koboldCppProvider({
      address: () => kobold.address,
      profile: (id) => ({ ...presetFor(id).profile, ...change }),
    });
  }

  test("a reply carries the loaded model's samplers, max_tokens and stop sequences, with the names filled in", async () => {
    await collect(
      provider().streamReply(
        request({
          names: { character: 'Mara Quill', player: 'The Traveller' },
        }),
      ),
    );

    expect(presetFor(FAKE_KOBOLDCPP_MODEL).name).toBe('Gemma');
    expect(kobold.requests[0]?.body).toMatchObject({
      max_tokens: GEMMA.maxReplyTokens,
      temperature: GEMMA.temperature,
      top_p: GEMMA.top_p,
      top_k: GEMMA.top_k,
      min_p: GEMMA.min_p,
      rep_pen: GEMMA.rep_pen,
      rep_pen_range: GEMMA.rep_pen_range,
      stop: ['\nThe Traveller:'],
    });
  });

  test('a chat with no player stops at "the user", as reply prompts call them', async () => {
    await collect(
      profiled({ stop: ['\n{user}:', '{character}:'] }).streamReply(
        request({ names: { character: 'Mara Quill', player: undefined } }),
      ),
    );

    expect(kobold.requests[0]?.body.stop).toEqual([
      '\nthe user:',
      'Mara Quill:',
    ]);
  });

  test("extraBody is merged into every request, but cannot change the app's own fields", async () => {
    const kobolds = profiled({
      extraBody: {
        top_a: 0.2,
        temperature: 0.5,
        model: 'other',
        stream: false,
      },
    });

    await collect(kobolds.streamReply(request()));
    await kobolds.structured({
      model: 'gpt-5-mini',
      instructions: 'Describe the moment.',
      input: 'Mara: Come in.',
      schemaName: 'scene',
      schema: SCENE_SCHEMA,
    });

    expect(kobold.requests[0]?.body).toMatchObject({
      model: FAKE_KOBOLDCPP_MODEL,
      stream: true,
      top_a: 0.2,
      temperature: 0.5,
    });
    expect(kobold.structuredRequests[0]).toMatchObject({
      model: FAKE_KOBOLDCPP_MODEL,
      stream: false,
      top_a: 0.2,
    });
  });

  test("the scene call uses the profile's scene temperature", async () => {
    await profiled({ sceneTemperature: 0.15 }).structured({
      model: 'gpt-5-mini',
      instructions: 'Describe the moment.',
      input: 'Mara: Come in.',
      schemaName: 'scene',
      schema: SCENE_SCHEMA,
    });

    expect(kobold.structuredRequests[0]?.temperature).toBe(0.15);
  });

  test('with merge-into-first-user, no system message is sent and the instructions come first in the first user message', async () => {
    await collect(
      profiled({ systemRole: 'merge-into-first-user' }).streamReply(
        request({
          messages: [
            { role: 'user', content: 'Hello?' },
            { role: 'assistant', content: 'Who goes there?' },
            { role: 'user', content: 'A traveller.' },
          ],
        }),
      ),
    );

    expect(kobold.requests[0]?.body.messages).toEqual([
      { role: 'user', content: 'You are Mara.\n\nHello?' },
      { role: 'assistant', content: 'Who goes there?' },
      { role: 'user', content: 'A traveller.' },
    ]);
  });

  test("with merge-into-first-user, a conversation that starts with the character's message gets the instructions as a user message before it", async () => {
    await collect(
      profiled({ systemRole: 'merge-into-first-user' }).streamReply(
        request({
          messages: [
            { role: 'assistant', content: 'You are late.' },
            { role: 'user', content: 'Sorry.' },
          ],
        }),
      ),
    );

    expect(kobold.requests[0]?.body.messages).toEqual([
      { role: 'user', content: 'You are Mara.' },
      { role: 'assistant', content: 'You are late.' },
      { role: 'user', content: 'Sorry.' },
    ]);
  });
});

describe('stopping', () => {
  const scene = (background: boolean) => ({
    model: 'gpt-5.5',
    instructions: 'Describe the scene.',
    input: 'Mara looks out.',
    schemaName: 'scene',
    schema: SCENE_SCHEMA,
    background,
  });

  test('stopping a reply keeps what was written and asks KoboldCpp to abort', async () => {
    kobold.respondWith({
      kind: 'reply',
      chunks: ['The lamp', ' is', ' lit.'],
      holdAfter: 1,
    });
    const controller = new AbortController();
    const pieces: string[] = [];

    await expect(async () => {
      for await (const piece of provider().streamReply(
        request({ signal: controller.signal }),
      )) {
        pieces.push(typeof piece === 'string' ? piece : '[thinking]');
        controller.abort();
      }
    }).rejects.toThrow();

    expect(pieces).toEqual(['The lamp']);
    await expect.poll(() => kobold.aborts).toBe(1);
  });

  test('a reply sets aside a scene call in the background, and KoboldCpp stops it before the reply is asked for', async () => {
    kobold.answerWith({
      kind: 'text',
      text: JSON.stringify(KOBOLD_SCENE),
      held: true,
    });
    const kobolds = provider();
    // Settled at once, so that its failure is not left unhandled meanwhile.
    const following = kobolds.structured(scene(true)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(() => kobold.structuredRequests.length).toBe(1);

    const pieces = await collect(kobolds.streamReply(request()));

    expect(pieces).toEqual(['Hello', ' from', ' the', ' local', ' model.']);
    expect(await following).toBeInstanceOf(ProviderError);
    expect(kobold.events).toEqual(['answer', 'abort', 'reply']);
  });

  test('a scene call the user asked for is not set aside by a reply', async () => {
    kobold.answerWith({
      kind: 'text',
      text: JSON.stringify(KOBOLD_SCENE),
      held: true,
    });
    const kobolds = provider();
    const asked = kobolds.structured(scene(false));
    await expect.poll(() => kobold.structuredRequests.length).toBe(1);

    const replying = collect(kobolds.streamReply(request()));
    await expect.poll(() => kobold.requests.length).toBe(1);
    kobold.release();

    expect(await asked).toEqual(KOBOLD_SCENE);
    await replying;
    expect(kobold.aborts).toBe(0);
  });

  test('stopping everything ends a generation in progress on KoboldCpp', async () => {
    kobold.respondWith({
      kind: 'reply',
      chunks: ['The lamp', ' is', ' lit.'],
      holdAfter: 1,
    });
    const kobolds = provider();
    const replying = collect(kobolds.streamReply(request())).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(() => kobold.requests.length).toBe(1);

    await kobolds.stopAll();

    expect(kobold.aborts).toBe(1);
    expect(await replying).toBeInstanceOf(ProviderError);
  });
});
