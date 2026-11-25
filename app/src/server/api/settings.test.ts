import { expect, test } from 'vitest';
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_MODEL,
  DEFAULT_SCENE_MODEL,
} from '../settings.ts';
import { testApp } from '../testing.ts';

test('settings start with the default model and say where the key comes from', async () => {
  const app = testApp({ environmentApiKey: 'sk-from-env' });

  const response = await app.call('GET', '/api/settings');

  expect(await response.json()).toEqual({
    model: DEFAULT_MODEL,
    reasoningEffort: null,
    sceneModel: DEFAULT_SCENE_MODEL,
    sceneReasoningEffort: null,
    illustrationMode: 'key-moments',
    illustrationCooldown: 3,
    imageStyle: 'realistic',
    contextTokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
    speechMuted: false,
    speechScope: 'dialogue',
    apiKey: 'environment',
  });
});

test('speech can be muted, and set to speak the whole reply', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    speechMuted: true,
    speechScope: 'everything',
  });

  expect(await response.json()).toMatchObject({
    speechMuted: true,
    speechScope: 'everything',
  });
});

test('a scope for speech that does not exist is refused with a reason', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    speechScope: 'whispers',
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'What is spoken must be "dialogue" or "everything".',
  });
});

test('a key can be saved, and is never sent back', async () => {
  const app = testApp();

  const saved = await app.call('PUT', '/api/settings', {
    apiKey: 'sk-secret-123',
  });
  const read = await app.call('GET', '/api/settings');

  const texts = [await saved.text(), await read.text()];
  expect(JSON.parse(texts[1] ?? '')).toMatchObject({ apiKey: 'saved' });
  expect(texts.join()).not.toContain('sk-secret-123');
  expect(app.settings.apiKey()).toBe('sk-secret-123');
});

test('a key that could not be a key is refused, without repeating it', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    apiKey: 'sk-secret\n-123',
  });

  const text = await response.text();
  expect(response.status).toBe(400);
  expect(text).toContain('An API key cannot contain spaces');
  expect(text).not.toContain('sk-secret');
  expect(app.settings.apiKey()).toBeUndefined();
});

test('the saved key can be forgotten', async () => {
  const app = testApp();
  await app.call('PUT', '/api/settings', { apiKey: 'sk-secret-123' });

  const response = await app.call('PUT', '/api/settings', { apiKey: null });

  expect(await response.json()).toMatchObject({ apiKey: 'missing' });
});

test('the model can be changed', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    model: '  another-model ',
  });

  expect(await response.json()).toMatchObject({ model: 'another-model' });
});

test('the scene model can be changed, and is never empty', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    sceneModel: ' small-model ',
  });
  const empty = await app.call('PUT', '/api/settings', { sceneModel: '' });

  expect(await response.json()).toMatchObject({ sceneModel: 'small-model' });
  expect(empty.status).toBe(400);
  expect(app.settings.sceneModel()).toBe('small-model');
});

test('the conversation token budget can be changed', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    contextTokenBudget: 4_000,
  });

  expect(await response.json()).toMatchObject({ contextTokenBudget: 4_000 });
});

test('a conversation token budget too small to be useful is refused with a reason', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    contextTokenBudget: 5,
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'The conversation budget must be at least 100 tokens.',
  });
});

test('an empty model name is refused with a reason', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', { model: ' ' });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'The model name cannot be empty.',
  });
});

test('the illustration mode and cooldown can be changed, within limits', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    illustrationMode: 'every-reply',
    illustrationCooldown: 5,
  });
  const badMode = await app.call('PUT', '/api/settings', {
    illustrationMode: 'sometimes',
  });
  const badCooldown = await app.call('PUT', '/api/settings', {
    illustrationCooldown: 0,
  });

  expect(await response.json()).toMatchObject({
    illustrationMode: 'every-reply',
    illustrationCooldown: 5,
  });
  expect(badMode.status).toBe(400);
  expect(badCooldown.status).toBe(400);
  expect(app.settings.illustrationMode()).toBe('every-reply');
});

test('a thinking level can be chosen for each model, and cleared again', async () => {
  const app = testApp();

  const chosen = await app.call('PUT', '/api/settings', {
    reasoningEffort: 'high',
    sceneReasoningEffort: 'minimal',
  });
  expect(await chosen.json()).toMatchObject({
    reasoningEffort: 'high',
    sceneReasoningEffort: 'minimal',
  });
  const cleared = await app.call('PUT', '/api/settings', {
    reasoningEffort: null,
  });

  expect(await cleared.json()).toMatchObject({
    reasoningEffort: null,
    sceneReasoningEffort: 'minimal',
  });
});

test('a thinking level that does not exist is refused with a reason', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    reasoningEffort: 'enormous',
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error:
      'The thinking level must be one of "none", "minimal", "low", "medium", "high", "xhigh", "max".',
  });
});

test('replies and scene descriptions are asked for at their chosen thinking levels', async () => {
  const app = testApp();
  await app.call('PUT', '/api/settings', {
    reasoningEffort: 'low',
    sceneReasoningEffort: 'minimal',
  });
  const chat = await app.startChat();

  await (
    await app.call('POST', `/api/chats/${chat.id}/messages`, {
      content: 'Hello?',
    })
  ).text();

  expect(app.provider.requests[0]?.reasoningEffort).toBe('low');
  await expect
    .poll(() => app.provider.structuredRequests[0]?.reasoningEffort)
    .toBe('minimal');
});

test('the image style can be changed, to a known style only', async () => {
  const app = testApp();

  const response = await app.call('PUT', '/api/settings', {
    imageStyle: 'illustration',
  });
  const bad = await app.call('PUT', '/api/settings', { imageStyle: 'cartoon' });

  expect(await response.json()).toMatchObject({ imageStyle: 'illustration' });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({
    error: 'The image style must be "realistic" or "illustration".',
  });
  expect(app.settings.imageStyle()).toBe('illustration');
});
