import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { messages, send } from './helpers.ts';

function replyPrompts(page: Page) {
  return page
    .getByRole('list', { name: 'Reply prompts' })
    .getByRole('listitem');
}

test('a reply prompt written in Settings can be chosen for a chat, whose instructions then end with it', async ({
  page,
  openai,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(replyPrompts(page)).toHaveText([/Default/]);
  await page.getByRole('link', { name: 'New reply prompt' }).click();
  // A new one starts from the default.
  await expect(page.getByLabel('Prompt')).toHaveValue(/^Reply only as/);
  await page.getByLabel('Name').fill('Narrator');
  await page
    .getByLabel('Prompt')
    .fill('Narrate in the third person, following {character} and {user}.');
  await page.getByRole('button', { name: 'Save reply prompt' }).click();
  await expect(replyPrompts(page)).toHaveText([/Default/, /Narrator/]);

  await page.getByRole('link', { name: 'New chat' }).click();
  await expect(
    page.getByLabel('Reply prompt').locator('option:checked'),
  ).toHaveText('Default');
  await page.getByLabel('Reply prompt').selectOption({ label: 'Narrator' });
  await expect(page.getByRole('main')).toContainText('Narrate in the third');
  await page.getByRole('button', { name: 'Start chat' }).click();

  await expect(page.getByRole('main')).toContainText('Reply prompt: Narrator');
  await send(page, 'Evening.');
  await expect(messages(page).last()).toContainText(
    'Hello from the fake model.',
  );
  const instructions = openai.requests[0]?.body.instructions ?? '';
  expect(instructions).toMatch(
    /# How to reply\n\nNarrate in the third person, following Mara Quill and The Traveller\.$/,
  );

  // The chat is counted against its reply prompt.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(
    replyPrompts(page).filter({ hasText: 'Narrator' }),
  ).toContainText('1 chat');
});

test('deleting a reply prompt asks first, and keeps its chats on the default', async ({
  page,
  openai,
}) => {
  await page.goto('/#/reply-prompts/new');
  await page.getByLabel('Name').fill('Terse');
  await page.getByLabel('Prompt').fill('Answer in one line.');
  await page.getByRole('button', { name: 'Save reply prompt' }).click();
  await page.getByRole('link', { name: 'New chat' }).click();
  await page.getByLabel('Reply prompt').selectOption({ label: 'Terse' });
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page.getByRole('main')).toContainText('Reply prompt: Terse');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delete Terse' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'The 1 chat using it will use the default',
  );
  await page.getByRole('button', { name: 'Delete reply prompt' }).click();
  await expect(replyPrompts(page)).toHaveText([/Default/]);

  await page
    .getByRole('navigation', { name: 'Chats' })
    .getByRole('link')
    .first()
    .click();
  await expect(page.getByRole('main')).not.toContainText('Reply prompt:');
  await send(page, 'Hello?');
  await expect(messages(page).last()).toContainText(
    'Hello from the fake model.',
  );
  expect(openai.requests[0]?.body.instructions).toContain(
    'Reply only as Mara Quill',
  );
});
