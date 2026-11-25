import { expect, test } from 'vitest';
import { ProviderError } from '../chat/provider.ts';
import { testApp } from '../testing.ts';

test('lists the models that can write replies', async () => {
  const app = testApp();

  const response = await app.call('GET', '/api/models');

  expect(await response.json()).toEqual({ models: ['gpt-5.5', 'gpt-4.1'] });
});

test('says why the models could not be listed', async () => {
  const app = testApp();
  app.provider.models = () =>
    Promise.reject(new ProviderError('OpenAI rejected the API key.'));

  const response = await app.call('GET', '/api/models');

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: 'OpenAI rejected the API key.',
  });
});

test("gives a model's thinking levels", async () => {
  const app = testApp();

  const response = await app.call('GET', '/api/models/gpt-5.5/reasoning');

  expect(await response.json()).toEqual({
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  });
});

test('gives no thinking levels for a model that does not think', async () => {
  const app = testApp();

  const response = await app.call('GET', '/api/models/gpt-4.1/reasoning');

  expect(await response.json()).toEqual({ efforts: [] });
});

test("says why a model's thinking levels could not be found out", async () => {
  const app = testApp();

  const response = await app.call('GET', '/api/models/gpt-0/reasoning');

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'No model called gpt-0.' });
});
