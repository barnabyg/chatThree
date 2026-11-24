import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { messages, send } from './helpers.ts';

function characters(page: Page) {
  return page.getByRole('list', { name: 'Characters' }).getByRole('listitem');
}

async function createTomas(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Characters' }).click();
  await page.getByRole('link', { name: 'New character' }).click();
  await page.getByLabel('Name').fill('Tomas Reed');
  await page
    .getByLabel('Persona')
    .fill('A ferryman who has never left the river.');
  await page.getByLabel('Speaking style').fill('Slow, with long pauses.');
  await page
    .getByLabel('Example dialogue')
    .fill('User: Can you take me across?\nTomas: In time.');
  await page.getByLabel('Appearance').fill('Tall, in a patched coat.');
  await page.getByRole('button', { name: 'Save character' }).click();
  await expect(
    characters(page).filter({ hasText: 'Tomas Reed' }),
  ).toBeVisible();
}

/** From the characters page, start a chat with `name` in the built-in scenario. */
async function chatWith(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: `Chat with ${name}` }).click();
  await expect(page.getByLabel('Character')).toContainText(name);
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('a new character can be chatted with, and its persona reaches OpenAI', async ({
  page,
  openai,
}) => {
  await page.goto('/');
  await createTomas(page);

  await chatWith(page, 'Tomas Reed');
  await send(page, 'Can you take me across?');
  await expect(messages(page)).toHaveText([
    /Tomas Reed\s*\*The door swings inward/,
    /You\s*Can you take me across\?/,
    /Tomas Reed\s*Hello from the fake model\./,
  ]);

  const instructions = openai.requests[0]?.body.instructions ?? '';
  expect(instructions).toContain('Tomas Reed');
  expect(instructions).toContain('A ferryman who has never left the river.');
  expect(instructions).toContain('Slow, with long pauses.');
  expect(instructions).toContain('Tomas: In time.');
  expect(instructions).not.toContain('Tall, in a patched coat.');

  // The character is saved.
  await page.reload();
  await page.getByRole('link', { name: 'Characters' }).click();
  await expect(characters(page)).toHaveText([/Mara Quill/, /Tomas Reed/]);
});

test('the built-in character can be edited like any other', async ({
  page,
  openai,
}) => {
  await page.goto('/#/characters');
  await page.getByRole('link', { name: 'Edit Mara Quill' }).click();
  await expect(page.getByLabel('Persona')).toHaveValue(/lighthouse/);

  await page.getByLabel('Name').fill('Mara the Keeper');
  await page.getByLabel('Persona').fill('She guards the northern light.');
  await page.getByRole('button', { name: 'Save character' }).click();
  await expect(characters(page)).toHaveText([/Mara the Keeper/]);

  await chatWith(page, 'Mara the Keeper');
  await send(page, 'Hello?');
  await expect(messages(page).last()).toContainText(
    'Hello from the fake model.',
  );

  expect(openai.requests[0]?.body.instructions).toContain(
    'She guards the northern light.',
  );
});

test('deleting a character with chats says what happens to them, and asks first', async ({
  page,
}) => {
  await page.goto('/');
  await createTomas(page);
  await chatWith(page, 'Tomas Reed');
  await page.getByRole('link', { name: 'Characters' }).click();
  await expect(
    characters(page).filter({ hasText: 'Tomas Reed' }),
  ).toContainText('1 chat');

  // Cancelling keeps the character.
  await page.getByRole('button', { name: 'Delete Tomas Reed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Tomas Reed?' });
  await expect(dialog).toContainText(
    'This also deletes the 1 chat with Tomas Reed, including every message in them. This cannot be undone.',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(characters(page)).toHaveCount(2);

  // Confirming deletes it and its chat.
  await page.getByRole('button', { name: 'Delete Tomas Reed' }).click();
  await dialog.getByRole('button', { name: 'Delete character' }).click();
  await expect(characters(page)).toHaveText([/Mara Quill/]);
  await expect(page.getByRole('navigation', { name: 'Chats' })).toContainText(
    'No chats yet.',
  );

  await page.reload();
  await expect(characters(page)).toHaveText([/Mara Quill/]);
  const chats = await page.request.get('/api/chats');
  expect(await chats.json()).toEqual([]);
});

test('a character cannot be saved without a name', async ({ page }) => {
  await page.goto('/#/characters/new');
  await page.getByLabel('Persona').fill('Someone with no name.');

  await page.getByRole('button', { name: 'Save character' }).click();

  // The browser stops the form at the required field: nothing is saved.
  await expect(
    page.getByRole('heading', { name: 'New character' }),
  ).toBeVisible();
  const saved = await page.request.get('/api/characters');
  expect(await saved.json()).toHaveLength(1);
});
