import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { temporaryDirectory } from '../../test-support/temporary.ts';
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_MODEL,
  SettingsStore,
} from './settings.ts';

function settingsFile(): string {
  return path.join(temporaryDirectory('settings'), 'settings.json');
}

test('with nothing saved, the model is the default and the key comes from the environment', () => {
  const settings = new SettingsStore(settingsFile(), 'sk-from-env');

  expect(settings.view()).toEqual({
    model: DEFAULT_MODEL,
    contextTokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
    apiKey: 'environment',
  });
  expect(settings.apiKey()).toBe('sk-from-env');
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
