import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  engineReady,
  giveMaraAPicture,
  messages,
  openLighthouseChat,
  send,
} from './helpers.ts';

const SCENE = {
  action: 'Mara climbs the stair.',
  expression: 'determined',
  framing: 'wide shot',
  lighting: 'storm light',
};

/** Illustrate a message and wait until its picture is there. */
async function illustrate(page: Page, message: number): Promise<void> {
  const item = messages(page).nth(message);
  await item.getByRole('button', { name: 'Illustrate' }).click();
  await expect(
    item.getByRole('img', { name: 'Illustration 1 of this moment' }),
  ).toBeVisible();
}

function locations(page: Page) {
  return page.getByRole('list', { name: 'Locations' }).getByRole('listitem');
}

test('when the story moves somewhere new, the place gets its own picture and illustrations show it', async ({
  page,
  app,
  openai,
}) => {
  await giveMaraAPicture(page);
  await openLighthouseChat(page);
  await engineReady(page);
  await expect(page.getByTestId('current-location')).toHaveText(
    'At The lighthouse kitchen',
  );

  // The opening message stays in the kitchen.
  await illustrate(page, 0);

  // The reply moves the story up the tower.
  openai.respondWith({
    kind: 'reply',
    chunks: ['*She takes the lantern and climbs to the lamp room.*'],
  });
  await send(page, 'Show me the lamp.');
  await expect(messages(page)).toHaveCount(3);
  openai.respondToStructuredWith({
    kind: 'json',
    value: {
      ...SCENE,
      moved: true,
      location: {
        name: 'The lamp room',
        description: 'A round glass room around the great lamp.',
      },
    },
  });
  await illustrate(page, 2);

  await expect(page.getByTestId('current-location')).toHaveText(
    'At The lamp room',
  );
  // A second place was painted, and the new scene was painted from it.
  const painted = (await app.engineJobs()).filter(
    (job) => job.path === '/image',
  );
  expect(painted).toHaveLength(4);
  expect(painted[2]?.body.prompt).toContain('A round glass room');
  const placeOf = (index: number) =>
    (painted[index]?.body.references as string[] | undefined)?.[1];
  expect(placeOf(3)).toBeDefined();
  expect(placeOf(3)).not.toBe(placeOf(1));

  // The chat's places are listed with their pictures, and kept.
  await page.reload();
  await expect(page.getByTestId('current-location')).toHaveText(
    'At The lamp room',
  );
  await page.getByText('Locations (2)').click();
  await expect(locations(page)).toHaveCount(2);
  await expect(locations(page).nth(1)).toContainText('(here now)');
  const kitchen = locations(page).first();
  const picture = kitchen.getByRole('img', {
    name: 'Reference picture of The lighthouse kitchen',
  });
  const before = await picture.getAttribute('src');

  // A place's picture can be painted again.
  await kitchen.getByRole('button', { name: 'Generate another' }).click();
  await expect(picture).not.toHaveAttribute('src', before ?? '');
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});
