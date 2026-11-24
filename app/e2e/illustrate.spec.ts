import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  engineReady,
  giveMaraAPicture,
  messages,
  openLighthouseChat,
  send,
} from './helpers.ts';

function opening(page: Page) {
  return messages(page).first();
}

/** Wait until the illustration is drawn: loaded, not a broken image. */
async function drawn(page: Page, index = 0): Promise<void> {
  const picture = opening(page).getByRole('img', {
    name: `Illustration ${String(index + 1)} of this moment`,
  });
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
}

test.describe('with a slow painter', () => {
  test.use({ appEnv: { FAKE_ENGINE_IMAGE_MS: '1500' } });

  test('a message is illustrated from the character and the starting location, and the picture is kept', async ({
    page,
    app,
    openai,
  }) => {
    await giveMaraAPicture(page);
    await openLighthouseChat(page);
    await engineReady(page);

    await opening(page).getByRole('button', { name: 'Illustrate' }).click();

    await expect(opening(page).getByRole('status')).toContainText('Painting');
    await drawn(page);
    await expect(opening(page).getByRole('status')).toBeHidden();

    // The scene call described the moment, from the conversation so far.
    expect(openai.structuredRequests).toHaveLength(1);
    // The starting location was painted alone, then the scene from both pictures.
    const painted = (await app.engineJobs()).filter(
      (job) => job.path === '/image',
    );
    expect(painted).toHaveLength(2);
    expect(painted[0]?.body.prompt).toContain('The lighthouse kitchen');
    expect(painted[0]?.body.references ?? []).toEqual([]);
    expect(painted[1]?.body.references).toHaveLength(2);

    // It is saved with the chat.
    await page.reload();
    await drawn(page);

    // And can be opened at full size.
    await opening(page)
      .getByRole('button', { name: 'Open illustration 1 at full size' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('img', {
        name: 'Illustration 1 of this moment, at full size',
      }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('speech carries on while a picture is painted', async ({
    page,
    app,
    openai,
  }) => {
    openai.respondWith({ kind: 'reply', chunks: ['"Sit by the stove."'] });
    await giveMaraAPicture(page);
    await openLighthouseChat(page);
    await engineReady(page);

    await opening(page).getByRole('button', { name: 'Illustrate' }).click();
    await expect(opening(page).getByRole('status')).toBeVisible();
    await send(page, 'Thank you.');

    // The reply is spoken while the picture is still being painted.
    await expect.poll(() => app.spoken()).toEqual(['Sit by the stove.']);
    await expect(opening(page).getByRole('status')).toBeVisible();
    await drawn(page);
  });
});

test('a failed illustration shows why, can be tried again, and the chat carries on', async ({
  page,
  openai,
}) => {
  openai.respondToStructuredWith({
    kind: 'http-error',
    status: 500,
    message: 'The server had an error.',
  });
  await giveMaraAPicture(page);
  await openLighthouseChat(page);
  await engineReady(page);

  await opening(page).getByRole('button', { name: 'Illustrate' }).click();

  const failure = opening(page).getByRole('alert');
  await expect(failure).toContainText('The server had an error.');

  // The chat carries on.
  await send(page, 'Is it always this rough?');
  await expect(messages(page).last()).toContainText(
    'Hello from the fake model.',
  );

  openai.respondToStructuredWith({
    kind: 'json',
    value: {
      action: 'Mara bolts the door.',
      expression: 'grim',
      framing: 'medium shot',
      lighting: 'storm light',
      moved: false,
      location: { name: '', description: '' },
    },
  });
  await failure.getByRole('button', { name: 'Try again' }).click();
  await drawn(page);
  await expect(failure).toBeHidden();
});

test('a character without a reference picture explains that one is needed', async ({
  page,
  openai,
}) => {
  await openLighthouseChat(page);

  await opening(page).getByRole('button', { name: 'Illustrate' }).click();

  const explanation = opening(page).getByRole('alert');
  await expect(explanation).toContainText(
    'Illustrating needs a reference picture of Mara Quill.',
  );
  expect(openai.structuredRequests).toHaveLength(0);
  await explanation
    .getByRole('link', { name: 'Give Mara Quill a picture' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Edit character' }),
  ).toBeVisible();
});
