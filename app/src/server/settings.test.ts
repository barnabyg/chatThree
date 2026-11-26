import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { temporaryDirectory } from '../../test-support/temporary.ts';
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_MODEL,
  DEFAULT_SCENE_MODEL,
  SettingsStore,
} from './settings.ts';

function settingsFile(): string {
  return path.join(temporaryDirectory('settings'), 'settings.json');
}

test('with nothing saved, the model is the default and the key comes from the environment', () => {
  const settings = new SettingsStore(settingsFile(), 'sk-from-env');

  expect(settings.view()).toEqual({
    textBackend: 'openai',
    koboldcppAddress: '',
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
  expect(settings.apiKey()).toBe('sk-from-env');
});

test('muting speech and what is spoken are saved, and read back by a later run', () => {
  const file = settingsFile();
  new SettingsStore(file, undefined).update({
    speechMuted: true,
    speechScope: 'everything',
  });

  expect(new SettingsStore(file, undefined).view()).toMatchObject({
    speechMuted: true,
    speechScope: 'everything',
  });
});

test('with no key anywhere, the key is reported missing', () => {
  const settings = new SettingsStore(settingsFile(), undefined);

  expect(settings.view().apiKey).toBe('missing');
  expect(settings.apiKey()).toBeUndefined();
});

test('a saved key is used in place of the environment key', () => {
  const settings = new SettingsStore(settingsFile(), 'sk-from-env');

  settings.update({ apiKey: 'sk-saved' });

  expect(settings.view().apiKey).toBe('saved');
  expect(settings.apiKey()).toBe('sk-saved');
});

test('the saved key and model survive a restart', () => {
  const file = settingsFile();
  new SettingsStore(file, undefined).update({
    apiKey: 'sk-saved',
    model: 'another-model',
  });

  const restarted = new SettingsStore(file, undefined);

  expect(restarted.apiKey()).toBe('sk-saved');
  expect(restarted.model()).toBe('another-model');
});

test('forgetting the saved key falls back to the environment key', () => {
  const settings = new SettingsStore(settingsFile(), 'sk-from-env');
  settings.update({ apiKey: 'sk-saved' });

  settings.update({ apiKey: null });

  expect(settings.view().apiKey).toBe('environment');
  expect(settings.apiKey()).toBe('sk-from-env');
});

test('the conversation token budget can be changed and survives a restart', () => {
  const file = settingsFile();
  new SettingsStore(file, undefined).update({ contextTokenBudget: 4_000 });

  expect(new SettingsStore(file, undefined).contextTokenBudget()).toBe(4_000);
});

test('changing the model leaves the saved key alone', () => {
  const settings = new SettingsStore(settingsFile(), undefined);
  settings.update({ apiKey: 'sk-saved' });

  settings.update({ model: 'another-model' });

  expect(settings.apiKey()).toBe('sk-saved');
});

test('the view of the settings never contains the key', () => {
  const settings = new SettingsStore(settingsFile(), 'sk-from-env');

  const view = JSON.stringify(settings.update({ apiKey: 'sk-saved' }));

  expect(view).not.toContain('sk-saved');
  expect(view).not.toContain('sk-from-env');
});

test('a damaged settings file is reported by path, without echoing its content', async () => {
  const file = settingsFile();
  await writeFile(file, '{"openaiApiKey": "sk-saved"');

  const open = (): SettingsStore => new SettingsStore(file, undefined);

  expect(open).toThrow(file);
  expect(open).not.toThrow(/sk-saved/);
});

test('the illustration mode and cooldown are saved, and read back by a later run', () => {
  const file = settingsFile();
  new SettingsStore(file, undefined).update({
    illustrationMode: 'off',
    illustrationCooldown: 7,
  });

  const restarted = new SettingsStore(file, undefined);

  expect(restarted.illustrationMode()).toBe('off');
  expect(restarted.illustrationCooldown()).toBe(7);
});

test.each([0, -2, 2.5, 101, '3'])(
  'a hand-edited cooldown of %j is ignored for the default',
  async (cooldown) => {
    const file = settingsFile();
    await writeFile(file, JSON.stringify({ illustrationCooldown: cooldown }));

    expect(new SettingsStore(file, undefined).illustrationCooldown()).toBe(3);
  },
);

test('the image style is saved and read back, and a hand-edited unknown one is ignored', async () => {
  const file = settingsFile();
  new SettingsStore(file, undefined).update({ imageStyle: 'illustration' });

  expect(new SettingsStore(file, undefined).imageStyle()).toBe('illustration');

  await writeFile(file, JSON.stringify({ imageStyle: 'cartoon' }));
  expect(new SettingsStore(file, undefined).imageStyle()).toBe('realistic');
});

test('settings saved before there was a choice of backend load as OpenAI, unchanged', async () => {
  const file = settingsFile();
  await writeFile(
    file,
    JSON.stringify({ model: 'gpt-4.1', openaiApiKey: 'sk-saved' }),
  );

  const settings = new SettingsStore(file, undefined);

  expect(settings.textBackend()).toBe('openai');
  expect(settings.koboldcppAddress()).toBe('');
  expect(settings.model()).toBe('gpt-4.1');
  expect(settings.apiKey()).toBe('sk-saved');
});

test('the text backend and the KoboldCpp address are saved, and read back by a later run', () => {
  const file = settingsFile();
  new SettingsStore(file, undefined).update({
    textBackend: 'koboldcpp',
    koboldcppAddress: 'http://192.168.1.50:5001',
  });

  const restarted = new SettingsStore(file, undefined);

  expect(restarted.textBackend()).toBe('koboldcpp');
  expect(restarted.koboldcppAddress()).toBe('http://192.168.1.50:5001');
});

test('a hand-edited unknown text backend is ignored for OpenAI', async () => {
  const file = settingsFile();
  await writeFile(file, JSON.stringify({ textBackend: 'llamacpp' }));

  expect(new SettingsStore(file, undefined).textBackend()).toBe('openai');
});
