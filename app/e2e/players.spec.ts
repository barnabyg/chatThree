import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { messages, send } from './helpers.ts';

const BOB = {
  name: 'Bob',
  background: 'A retired lock-keeper who knows every eddy of the river.',
};

function players(page: Page) {
  return page.getByRole('list', { name: 'Players' }).getByRole('listitem');
}

test('a player can be created and chosen for a chat, whose prompt then describes them', async ({
  page,
  openai,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Players' }).click();
  await page.getByRole('link', { name: 'New player' }).click();
  await page.getByLabel('Name').fill(BOB.name);
  await page.getByLabel('Background').fill(BOB.background);
  await page.getByRole('button', { name: 'Save player' }).click();
  await expect(players(page)).toHaveText([/Bob/, /The Traveller/]);

  // A player's Chat button starts a new chat with them chosen.
  await page.getByRole('link', { name: 'Start a chat as Bob' }).click();
  await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
  await expect(page.getByLabel('Player').locator('option:checked')).toHaveText(
    'Bob',
  );
  await expect(page.getByRole('main')).toContainText(BOB.background);
  await page.getByRole('button', { name: 'Start chat' }).click();

  await expect(page.getByRole('main')).toContainText('Playing as Bob');
  await send(page, 'Evening. Mind if I sit?');
  await expect(messages(page).last()).toContainText(
    'Hello from the fake model.',
  );
  const instructions = openai.requests[0]?.body.instructions ?? '';
  expect(instructions).toContain(
    `## The part the user plays\nBob\n${BOB.background}`,
  );
  expect(instructions).not.toContain('The Traveller');

  // The chat is counted against its player.
  await page.getByRole('link', { name: 'Players' }).click();
  await expect(players(page).filter({ hasText: 'Bob' })).toContainText(
    '1 chat',
  );
});

test('a chat can be played as no one', async ({ page, openai }) => {
  await page.goto('/#/chats/new');
  await page.getByLabel('Player').selectOption({ label: 'No player' });
  await page.getByRole('button', { name: 'Start chat' }).click();

  await expect(page.getByRole('heading', { name: 'Mara Quill' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('Playing as');
  await send(page, 'Hello?');
  await expect(messages(page).last()).toContainText(
    'Hello from the fake model.',
  );
  expect(openai.requests[0]?.body.instructions).not.toContain(
    'The part the user plays',
  );
});

test('deleting a player asks first, then deletes their chats', async ({
  page,
}) => {
  await page.goto('/#/chats/new');
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page.getByRole('main')).toContainText(
    'Playing as The Traveller',
  );

  await page.getByRole('link', { name: 'Players' }).click();
  await page.getByRole('button', { name: 'Delete The Traveller' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'This also deletes the 1 chat played as The Traveller',
  );
  await page.getByRole('button', { name: 'Delete player' }).click();

  await expect(players(page)).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Chats' }).getByRole('link'),
  ).toHaveCount(0);
});
