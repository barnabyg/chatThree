import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { create, messages, send } from './helpers.ts';

const FERRY = {
  title: 'The Night Ferry',
  premise: 'The last ferry of the night is leaving, and it is not empty.',
  userPersona: { name: 'Wren', description: 'A courier with a sealed letter.' },
  openingMessage: 'You are late. Get aboard.',
  startingLocation: {
    name: 'The river quay',
    description: 'Fog, lantern light and black water.',
  },
};

function scenarios(page: Page) {
  return page.getByRole('list', { name: 'Scenarios' }).getByRole('listitem');
}

function chatLinks(page: Page) {
  return page.getByRole('navigation', { name: 'Chats' }).getByRole('link');
}

async function builtInCharacterId(page: Page): Promise<string> {
  const characters = (await (
    await page.request.get('/api/characters')
  ).json()) as { id: string }[];
  return characters[0]?.id ?? '';
}

test('the first run offers the built-in character and scenario, and the chat opens with the opening message', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
  await expect(page.getByLabel('Character')).toContainText('Mara Quill');
  await expect(page.getByLabel('Scenario')).toContainText(
    'The Storm at Gull Point',
  );
  await page.getByRole('button', { name: 'Start chat' }).click();

  await expect(page.getByRole('heading', { name: 'Mara Quill' })).toBeVisible();
  await expect(messages(page)).toHaveText([
    /Mara Quill\s*\*The door swings inward/,
  ]);
});

test('a scenario can be created, and a chat started from a pairing opens with its opening message', async ({
  page,
  openai,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Scenarios' }).click();
  await page.getByRole('link', { name: 'New scenario' }).click();
  await page.getByLabel('Title').fill(FERRY.title);
  await page.getByLabel('Premise').fill(FERRY.premise);
  await page.getByLabel("Your character's name").fill(FERRY.userPersona.name);
  await page
    .getByLabel('About your character')
    .fill(FERRY.userPersona.description);
  await page.getByLabel('Opening message').fill(FERRY.openingMessage);
  await page.getByLabel('Location name').fill(FERRY.startingLocation.name);
  await page
    .getByLabel('Location description')
    .fill(FERRY.startingLocation.description);
  await page.getByRole('button', { name: 'Save scenario' }).click();
  await expect(scenarios(page)).toHaveText([
    /The Night Ferry/,
    /The Storm at Gull Point/,
  ]);

  // Start a chat by choosing the pairing.
  await page.getByRole('link', { name: 'New chat' }).click();
  await page.getByLabel('Character').selectOption({ label: 'Mara Quill' });
  await page.getByLabel('Scenario').selectOption({ label: 'The Night Ferry' });
  await page.getByRole('button', { name: 'Start chat' }).click();

  await expect(page.getByRole('heading', { name: 'Mara Quill' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('The Night Ferry');
  await expect(messages(page)).toHaveText([
    /Mara Quill\s*You are late\. Get aboard\./,
  ]);

  // The prompt carries the premise and the user's part; the opening message
  // starts the conversation.
  await send(page, 'Wait for me!');
  await expect(messages(page)).toHaveCount(3);
  const request = openai.requests[0]?.body;
  expect(request?.instructions).toContain(FERRY.premise);
  expect(request?.instructions).toContain('Wren');
  expect(request?.instructions).toContain(FERRY.userPersona.description);
  expect(request?.instructions).toContain(FERRY.startingLocation.name);
  expect(request?.input).toEqual([
    { role: 'assistant', content: FERRY.openingMessage },
    { role: 'user', content: 'Wait for me!' },
  ]);

  // The scenario and the chat are saved.
  await page.reload();
  await expect(messages(page)).toHaveCount(3);
  await page.getByRole('link', { name: 'Scenarios' }).click();
  await expect(
    scenarios(page).filter({ hasText: 'The Night Ferry' }),
  ).toContainText('1 chat');
});

test('the chat list shows every chat, moves between them, and deletes one', async ({
  page,
}) => {
  await page.goto('/');
  const characterId = await builtInCharacterId(page);
  const ferry = await create(page, '/api/scenarios', FERRY);
  const quiet = await create(page, '/api/scenarios', {
    title: 'A Quiet Morning',
    openingMessage: 'The kettle is on.',
  });
  await create(page, '/api/chats', { characterId, scenarioId: ferry.id });
  const second = await create(page, '/api/chats', {
    characterId,
    scenarioId: quiet.id,
  });

  // The front page opens the most recently active chat.
  await page.goto('/');
  await expect(messages(page)).toHaveText([/The kettle is on\./]);
  expect(page.url()).toContain(second.id);

  // Each chat is listed with its character, its scenario and when it was last active.
  const links = chatLinks(page);
  await expect(links).toHaveText([
    /Mara Quill\s*A Quiet Morning/,
    /Mara Quill\s*The Night Ferry/,
  ]);
  await expect(links.first().locator('time')).toHaveAttribute(
    'datetime',
    /^\d{4}-\d{2}-\d{2}T/,
  );

  // Switching shows the other conversation, and activity moves a chat to the top.
  await links.nth(1).click();
  await expect(messages(page)).toHaveText([/You are late\. Get aboard\./]);
  await send(page, 'Wait for me!');
  await expect(messages(page)).toHaveCount(3);
  await expect(links).toHaveText([
    /Mara Quill\s*The Night Ferry/,
    /Mara Quill\s*A Quiet Morning/,
  ]);

  // Deleting the chat on screen asks first, then moves to the one that is left.
  await page
    .getByRole('button', {
      name: 'Delete the chat with Mara Quill in The Night Ferry',
    })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Delete this chat?' });
  await expect(dialog).toContainText(
    'The chat with Mara Quill in The Night Ferry and every message in it will be deleted.',
  );
  await dialog.getByRole('button', { name: 'Delete chat' }).click();

  await expect(links).toHaveText([/Mara Quill\s*A Quiet Morning/]);
  await expect(messages(page)).toHaveText([/The kettle is on\./]);

  await page.reload();
  await expect(links).toHaveText([/Mara Quill\s*A Quiet Morning/]);
});

test('deleting a scenario with chats says what happens to them, and asks first', async ({
  page,
}) => {
  await page.goto('/');
  const ferry = await create(page, '/api/scenarios', FERRY);
  await create(page, '/api/chats', {
    characterId: await builtInCharacterId(page),
    scenarioId: ferry.id,
  });
  await page.goto('/#/scenarios');

  await page.getByRole('button', { name: 'Delete The Night Ferry' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete The Night Ferry?' });
  await expect(dialog).toContainText(
    'This also deletes the 1 chat set in The Night Ferry, including every message in them. This cannot be undone.',
  );
  await dialog.getByRole('button', { name: 'Delete scenario' }).click();

  await expect(scenarios(page)).toHaveText([/The Storm at Gull Point/]);
  await expect(page.getByRole('navigation', { name: 'Chats' })).toContainText(
    'No chats yet.',
  );
});

test('a scenario can be edited', async ({ page }) => {
  await page.goto('/#/scenarios');
  await page
    .getByRole('link', { name: 'Edit The Storm at Gull Point' })
    .click();
  await expect(page.getByLabel('Opening message')).toHaveValue(
    /The door swings inward/,
  );

  await page.getByLabel('Title').fill('The Long Night');
  await page.getByRole('button', { name: 'Save scenario' }).click();

  await expect(scenarios(page)).toHaveText([/The Long Night/]);
  await page.reload();
  await expect(scenarios(page)).toHaveText([/The Long Night/]);
});
