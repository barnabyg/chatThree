import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { solidPng } from '../test-support/png.ts';
import { expect, test } from './fixtures.ts';

function picture(page: Page) {
  return page.getByRole('group', { name: 'Picture' });
}

async function editMara(page: Page): Promise<void> {
  await page.goto('/#/characters');
  await page.getByRole('link', { name: 'Edit Mara Quill' }).click();
  await expect(picture(page)).toBeVisible();
}

async function engineReady(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Engine' })).toContainText(
    'Engine ready',
  );
}

/** The picture shown in the editor: its address, and the image itself. */
async function shown(page: Page): Promise<{ src: string; bytes: Buffer }> {
  const image = picture(page).getByRole('img', {
    name: 'Reference picture of Mara Quill',
  });
  await expect(image).toBeVisible();
  // Loaded and drawn, not a broken image.
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const src = (await image.getAttribute('src')) ?? '';
  return { src, bytes: await (await page.request.get(src)).body() };
}

test('a reference picture is generated from the appearance, regenerated, and kept', async ({
  page,
  app,
}, testInfo) => {
  await editMara(page);
  await engineReady(page);
  await expect(picture(page)).toContainText('No picture yet.');
  // The appearance is used as it reads now, without saving the character first.
  await page.getByLabel('Appearance').fill('A tall woman in a red oilskin.');

  await picture(page).getByRole('button', { name: 'Generate picture' }).click();

  const first = await shown(page);
  expect(first.bytes.subarray(1, 4).toString()).toBe('PNG');
  const [asked] = await app.engineJobs();
  expect(asked?.path).toBe('/image');
  expect(asked?.body.prompt).toContain('A tall woman in a red oilskin.');
  expect(asked?.body).toMatchObject({ width: 768, height: 1024 });

  // Generating again gives a different picture, in place of the first.
  await picture(page).getByRole('button', { name: 'Generate another' }).click();
  await expect.poll(async () => (await shown(page)).src).not.toBe(first.src);
  const second = await shown(page);
  expect(second.bytes.equals(first.bytes)).toBe(false);
  const seeds = (await app.engineJobs()).map((job) => job.body.seed);
  expect(seeds).toHaveLength(2);
  expect(seeds[0]).not.toBe(seeds[1]);

  // The picture is in the app's data folder, and only the one in use is kept.
  const folder = testInfo.outputPath('data', 'images');
  const files = await readdir(folder);
  expect(files).toHaveLength(1);
  expect(
    (
      await readFile(testInfo.outputPath('data', 'images', files[0] ?? ''))
    ).equals(second.bytes),
  ).toBe(true);

  // It is saved with the character, and shown on it in the list.
  await page.reload();
  expect((await shown(page)).src).toBe(second.src);
  await page.getByRole('link', { name: 'Characters' }).click();
  await expect(
    page
      .getByRole('list', { name: 'Characters' })
      .getByRole('img', { name: 'Picture of Mara Quill' }),
  ).toBeVisible();
});

test("a picture of the user's own can be uploaded instead", async ({
  page,
}, testInfo) => {
  const own = solidPng(24, 32, [200, 40, 40]);
  const file = testInfo.outputPath('portrait.png');
  await writeFile(file, own);
  await editMara(page);
  await engineReady(page);
  await picture(page).getByRole('button', { name: 'Generate picture' }).click();
  const generated = await shown(page);

  await picture(page).getByLabel('Upload a picture').setInputFiles(file);

  await expect
    .poll(async () => (await shown(page)).src)
    .not.toBe(generated.src);
  expect((await shown(page)).bytes.equals(Buffer.from(own))).toBe(true);

  await page.reload();
  expect((await shown(page)).bytes.equals(Buffer.from(own))).toBe(true);
});

test('a file that is not a picture is refused', async ({ page }, testInfo) => {
  const notes = testInfo.outputPath('notes.png');
  await writeFile(notes, 'These are notes, not a picture.');
  await editMara(page);

  await picture(page).getByLabel('Upload a picture').setInputFiles(notes);

  await expect(picture(page).getByRole('alert')).toHaveText(
    'A picture must be a PNG, JPEG or WebP image.',
  );
  await expect(picture(page)).toContainText('No picture yet.');
});

test.describe('with an engine that is not ready', () => {
  test.use({ appEnv: { FAKE_ENGINE_MODE: 'failed' } });

  test('generating says so, and the rest of the editor still works', async ({
    page,
  }, testInfo) => {
    await editMara(page);

    await picture(page)
      .getByRole('button', { name: 'Generate picture' })
      .click();

    await expect(picture(page).getByRole('alert')).toHaveText(
      'A picture cannot be made because the engine is not ready.',
    );
    await expect(picture(page)).toContainText('No picture yet.');

    // A picture can still be uploaded, which needs no engine.
    const file = testInfo.outputPath('portrait.png');
    await writeFile(file, solidPng(8, 8, [10, 120, 200]));
    await picture(page).getByLabel('Upload a picture').setInputFiles(file);
    await shown(page);
    await expect(picture(page).getByRole('alert')).toBeHidden();

    // And the character can still be edited and saved.
    await page.getByLabel('Name').fill('Mara the Keeper');
    await page.getByRole('button', { name: 'Save character' }).click();
    await expect(page.getByRole('list', { name: 'Characters' })).toContainText(
      'Mara the Keeper',
    );
  });
});
