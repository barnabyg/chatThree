import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { wavSeconds } from '../src/shared/wav.ts';
import { recording } from '../test-support/recording.ts';
import { expect, type RunningApp, test } from './fixtures.ts';
import { editMara, engineReady, send } from './helpers.ts';

/** Write a recording of the given length to a file of the test's own. */
async function recordingFile(
  testInfo: TestInfo,
  name: string,
  seconds: number,
): Promise<string> {
  const file = testInfo.outputPath(name);
  await writeFile(file, recording(seconds));
  return file;
}

function voice(page: Page) {
  return page.getByRole('group', { name: 'Voice' });
}

/** The clip each sentence was spoken from, in order: `undefined` is the built-in voice. */
async function voicesUsed(app: RunningApp): Promise<unknown[]> {
  return (await app.engineJobs())
    .filter((job) => job.path === '/speech')
    .map((job) => job.body.voice);
}

/** Play the sample line and return the clip it was spoken from. */
async function previewedVoice(page: Page, app: RunningApp): Promise<unknown> {
  const before = (await voicesUsed(app)).length;
  await voice(page).getByRole('button', { name: 'Preview voice' }).click();
  await expect
    .poll(async () => (await voicesUsed(app)).length)
    .toBe(before + 1);
  // The sample is played to its end.
  await expect(
    voice(page).getByRole('button', { name: 'Preview voice' }),
  ).toBeVisible();
  return (await voicesUsed(app)).at(-1);
}

test("a character's replies are spoken in the voice cloned from its clip, warmed up when the chat opens", async ({
  page,
  openai,
  app,
}, testInfo) => {
  openai.respondWith({
    kind: 'reply',
    chunks: ['"Sit down. The tea is in the tin."'],
  });
  await editMara(page);
  await engineReady(page);
  await expect(voice(page)).toContainText('spoken in the built-in voice');

  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'mara.wav', 8));

  await expect(voice(page)).toContainText(
    'spoken in the voice cloned from the clip you gave',
  );
  // The clip is saved with the character.
  await page.reload();
  await expect(voice(page)).toContainText(
    'spoken in the voice cloned from the clip you gave',
  );

  // Opening a chat with the character prepares its voice, before anything is said.
  await page.getByRole('link', { name: 'Characters' }).click();
  await page.getByRole('link', { name: 'Chat with Mara Quill' }).click();
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page.getByRole('heading', { name: 'Mara Quill' })).toBeVisible();
  await expect
    .poll(async () => (await app.engineJobs()).map((job) => job.path).join(' '))
    .toBe('/voice');
  const [warmed] = await app.engineJobs();
  const clip = String(warmed?.body.voice);

  // The clip is in the app's data folder, and is the recording, as a WAV file.
  expect(path.dirname(clip)).toBe(testInfo.outputPath('data', 'voices'));
  expect(wavSeconds(await readFile(clip))).toBeCloseTo(8, 1);

  // Every sentence of the reply is spoken from that clip.
  await send(page, 'Is there anything hot to drink?');
  await expect
    .poll(() => app.spoken())
    .toEqual(['Sit down.', 'The tea is in the tin.']);
  expect(await voicesUsed(app)).toEqual([clip, clip]);
});

test('a voice clip can be previewed, replaced and removed', async ({
  page,
  app,
}, testInfo) => {
  await editMara(page);
  await engineReady(page);

  // Without a clip, the sample is in the built-in voice.
  expect(await previewedVoice(page, app)).toBeUndefined();
  expect((await app.spoken()).at(-1)).toBe(
    'Hello. I am Mara Quill. This is how I sound.',
  );

  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'first.wav', 6));
  await expect(voice(page)).toContainText('cloned from the clip you gave');
  const first = await previewedVoice(page, app);
  expect(wavSeconds(await readFile(String(first)))).toBeCloseTo(6, 1);

  // A second clip takes the place of the first.
  const replaced = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().endsWith('/voice'),
  );
  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'second.wav', 9));
  await replaced;
  const second = await previewedVoice(page, app);
  expect(second).not.toBe(first);
  expect(wavSeconds(await readFile(String(second)))).toBeCloseTo(9, 1);

  await voice(page).getByRole('button', { name: 'Remove voice clip' }).click();
  await expect(voice(page)).toContainText('spoken in the built-in voice');
  expect(await previewedVoice(page, app)).toBeUndefined();
  await expect(
    voice(page).getByRole('button', { name: 'Remove voice clip' }),
  ).toBeHidden();
});

test('a clip too short to clone a voice from is refused, saying how long it must be', async ({
  page,
}, testInfo) => {
  await editMara(page);

  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'short.wav', 3));

  await expect(voice(page).getByRole('alert')).toHaveText(
    'That recording is 3.0 seconds long. A voice clip must be longer than 5 seconds.',
  );
  await expect(voice(page)).toContainText('spoken in the built-in voice');
});

test('a file that is not a recording is refused', async ({
  page,
}, testInfo) => {
  await editMara(page);
  const notes = testInfo.outputPath('notes.wav');
  await writeFile(notes, 'These are notes, not sound.');

  await voice(page).getByLabel('Voice clip').setInputFiles(notes);

  await expect(voice(page).getByRole('alert')).toContainText(
    'not a recording this browser can read',
  );
  // The rest of the editor still works.
  await page.getByLabel('Name').fill('Mara the Keeper');
  await page.getByRole('button', { name: 'Save character' }).click();
  await expect(page.getByRole('list', { name: 'Characters' })).toContainText(
    'Mara the Keeper',
  );
});

test('a new character can be given a voice clip, saved with the character', async ({
  page,
  app,
}, testInfo) => {
  await page.goto('/#/characters/new');
  await engineReady(page);
  await page.getByLabel('Name').fill('Tomas Reed');
  await expect(voice(page)).toContainText('spoken in the built-in voice');
  // Before a clip is chosen, the built-in voice can be heard.
  expect(await previewedVoice(page, app)).toBeUndefined();

  // A clip too short is refused before anything is saved.
  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'short.wav', 3));
  await expect(voice(page).getByRole('alert')).toHaveText(
    'That recording is 3.0 seconds long. A voice clip must be longer than 5 seconds.',
  );

  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'tomas.wav', 7));
  await expect(voice(page)).toContainText(
    'will be spoken in the voice cloned from the clip you gave',
  );
  await expect(voice(page).getByRole('alert')).toBeHidden();
  // The cloned voice can be heard only once the clip is saved.
  await expect(
    voice(page).getByRole('button', { name: 'Preview voice' }),
  ).toBeDisabled();
  expect(
    await page.request.get('/api/characters').then((r) => r.json()),
  ).toHaveLength(1);

  await page.getByRole('button', { name: 'Save character' }).click();
  await page.getByRole('link', { name: 'Edit Tomas Reed' }).click();

  await expect(voice(page)).toContainText(
    'spoken in the voice cloned from the clip you gave',
  );
  const clip = await previewedVoice(page, app);
  expect(path.dirname(String(clip))).toBe(
    testInfo.outputPath('data', 'voices'),
  );
  expect(wavSeconds(await readFile(String(clip)))).toBeCloseTo(7, 1);
});

test("a new character's clip can be removed before it is saved", async ({
  page,
}, testInfo) => {
  await page.goto('/#/characters/new');
  await page.getByLabel('Name').fill('Tomas Reed');
  await voice(page)
    .getByLabel('Voice clip')
    .setInputFiles(await recordingFile(testInfo, 'tomas.wav', 7));
  await expect(voice(page)).toContainText('will be spoken in the voice cloned');

  await voice(page).getByRole('button', { name: 'Remove voice clip' }).click();
  await expect(voice(page)).toContainText('spoken in the built-in voice');
  await page.getByRole('button', { name: 'Save character' }).click();
  await page.getByRole('link', { name: 'Edit Tomas Reed' }).click();

  await expect(voice(page)).toContainText('spoken in the built-in voice');
});
