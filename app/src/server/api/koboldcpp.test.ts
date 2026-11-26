import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  FAKE_CONTEXT_LENGTH,
  FAKE_KOBOLDCPP_MODEL,
  type FakeKoboldCpp,
  startFakeKoboldCpp,
} from '../../../test-support/fake-koboldcpp.ts';
import type { Chat, Settings } from '../../shared/api.ts';
import { replyEvents, type TestApp, testApp } from '../testing.ts';

// The KoboldCpp text backend through the API, against a fake KoboldCpp.

let kobold: FakeKoboldCpp;
beforeEach(async () => {
  kobold = await startFakeKoboldCpp();
});
afterEach(async () => {
  await kobold.close();
});

/** An app with KoboldCpp chosen as the backend, and an OpenAI key saved. */
async function koboldApp(): Promise<TestApp> {
  const app = testApp({ environmentApiKey: 'sk-from-env' });
  const response = await app.call('PUT', '/api/settings', {
    textBackend: 'koboldcpp',
    koboldcppAddress: kobold.address,
    apiKey: 'sk-saved-secret',
  });
  expect(response.status).toBe(200);
  return app;
}

function send(app: TestApp, chat: Chat, content: string): Promise<Response> {
  return app.call('POST', `/api/chats/${chat.id}/messages`, { content });
}

test('with KoboldCpp chosen, replies come from KoboldCpp and not from OpenAI', async () => {
  const app = await koboldApp();
  const chat = await app.startChat();

  const events = await replyEvents(await send(app, chat, 'Hello?'));

  expect(events.at(-1)).toMatchObject({
    type: 'done',
    message: { role: 'assistant', content: 'Hello from the local model.' },
  });
  expect(app.provider.requests).toEqual([]);
  expect(kobold.requests).toHaveLength(1);
});

test('changing the backend takes effect on the next reply, without a restart', async () => {
  const app = await koboldApp();
  const chat = await app.startChat();
  await replyEvents(await send(app, chat, 'Hello?'));

  await app.call('PUT', '/api/settings', { textBackend: 'openai' });
  await replyEvents(await send(app, chat, 'Still there?'));

  expect(kobold.requests).toHaveLength(1);
  expect(app.provider.requests).toHaveLength(1);
});

test('the OpenAI key is never sent to KoboldCpp', async () => {
  const app = await koboldApp();
  const chat = await app.startChat();

  await replyEvents(await send(app, chat, 'Hello?'));

  expect(JSON.stringify(kobold.requests)).not.toContain('sk-');
});

test('regenerating and deleting work with KoboldCpp as with OpenAI', async () => {
  const app = await koboldApp();
  const chat = await app.startChat();
  kobold.respondWith(
    { kind: 'reply', chunks: ['First.'] },
    { kind: 'reply', chunks: ['Second.'] },
  );
  await replyEvents(await send(app, chat, 'Hello?'));

  await replyEvents(await app.call('POST', `/api/chats/${chat.id}/regenerate`));
  const regenerated = (await (
    await app.call('GET', `/api/chats/${chat.id}`)
  ).json()) as Chat;
  expect(regenerated.messages.map(({ content }) => content)).toEqual([
    'Hello?',
    'Second.',
  ]);

  await app.call('DELETE', `/api/chats/${chat.id}/messages/last`);
  const deleted = (await (
    await app.call('GET', `/api/chats/${chat.id}`)
  ).json()) as Chat;
  expect(deleted.messages.map(({ content }) => content)).toEqual(['Hello?']);
});

test('stopping a reply from KoboldCpp keeps what was written', async () => {
  const app = await koboldApp();
  const chat = await app.startChat();
  kobold.respondWith({
    kind: 'reply',
    chunks: ['The lamp', ' is', ' lit.'],
    holdAfter: 1,
  });

  const response = await send(app, chat, 'Hello?');
  await expect.poll(() => kobold.requests.length).toBe(1);
  await app.call('POST', `/api/chats/${chat.id}/stop`);
  const events = await replyEvents(response);

  expect(events.at(-1)).toMatchObject({
    type: 'done',
    message: { content: 'The lamp' },
  });
  await expect.poll(() => kobold.requests[0]?.abandoned).toBe(true);
});

test('a reply that fails names KoboldCpp and its address', async () => {
  const app = await koboldApp();
  const chat = await app.startChat();
  kobold.respondWith({
    kind: 'http-error',
    status: 500,
    body: { detail: { msg: 'Out of memory' } },
  });

  const events = await replyEvents(await send(app, chat, 'Hello?'));

  expect(events.at(-1)).toEqual({
    type: 'error',
    message: `KoboldCpp at ${kobold.address} returned an error (500): Out of memory`,
  });
});

test('the models are the one KoboldCpp has loaded, with no thinking levels', async () => {
  const app = await koboldApp();

  const models = await app.call('GET', '/api/models');
  const levels = await app.call(
    'GET',
    `/api/models/${encodeURIComponent(FAKE_KOBOLDCPP_MODEL)}/reasoning`,
  );

  expect(await models.json()).toEqual({ models: [FAKE_KOBOLDCPP_MODEL] });
  expect(await levels.json()).toEqual({ efforts: [] });
});

test('a model list that cannot be had names KoboldCpp', async () => {
  const app = await koboldApp();
  kobold.load(undefined);

  const response = await app.call('GET', '/api/models');

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: `KoboldCpp at ${kobold.address} has no model loaded.`,
  });
});

test('testing the connection gives the loaded model and its context length', async () => {
  const app = testApp();

  const response = await app.call('POST', '/api/koboldcpp/check', {
    address: `${kobold.address}/`,
  });

  expect(await response.json()).toEqual({
    model: FAKE_KOBOLDCPP_MODEL,
    contextLength: FAKE_CONTEXT_LENGTH,
  });
});

test('testing a connection that fails says why', async () => {
  const app = testApp();
  const address = kobold.address;
  await kobold.close();

  const response = await app.call('POST', '/api/koboldcpp/check', {
    address,
  });

  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: string }).error).toMatch(
    new RegExp(`^Could not reach KoboldCpp at ${address}`),
  );
});

test.each(['', 'http://192.168.1.50:5001/v1'])(
  'testing the address %j is refused with a reason',
  async (address) => {
    const app = testApp();

    const response = await app.call('POST', '/api/koboldcpp/check', {
      address,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'The KoboldCpp address must be a server address such as http://192.168.1.50:5001, with nothing after the port.',
    });
  },
);

test('the address is saved without a trailing slash, and with http:// if none was typed', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    koboldcppAddress: ' 192.168.1.50:5001/ ',
  });

  expect(((await response.json()) as Settings).koboldcppAddress).toBe(
    'http://192.168.1.50:5001',
  );
});

test('an address with a path is refused with a reason', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    koboldcppAddress: 'http://192.168.1.50:5001/v1/chat/completions',
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error:
      'The KoboldCpp address must be a server address such as http://192.168.1.50:5001, with nothing after the port.',
  });
});

test('a backend that does not exist is refused with a reason', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    textBackend: 'llamacpp',
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'The text backend must be "openai" or "koboldcpp".',
  });
});

test('saving the connection settings finds out again which model is loaded', async () => {
  const app = await koboldApp();
  await expect.poll(() => kobold.modelChecks).toBe(1);
  kobold.load('koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M');

  await app.call('PUT', '/api/settings', { koboldcppAddress: kobold.address });

  await expect
    .poll(async () => (await app.koboldcpp.loadedModel()).id)
    .toBe('koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M');
});
