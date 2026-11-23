import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

function messages(page: Page) {
  return page.getByRole('list', { name: 'Conversation' }).getByRole('listitem');
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('the last reply can be regenerated, and the new reply is the one saved', async ({
  page,
  openai,
}) => {
  openai.respondWith(
    { kind: 'reply', chunks: ['The first answer.'] },
    { kind: 'reply', chunks: ['A different', ' answer.'] },
  );
  await page.goto('/');
  await send(page, 'Who are you?');
  await expect(messages(page)).toHaveText([
    /Who are you\?/,
    /The first answer\./,
  ]);

  await page.getByRole('button', { name: 'Regenerate' }).click();

  await expect(messages(page)).toHaveText([
    /Who are you\?/,
    /A different answer\./,
  ]);
  // The new reply answers the same conversation as the first did.
  expect(openai.requests[1]?.body.input).toEqual(
    openai.requests[0]?.body.input,
  );

  await page.reload();
  await expect(messages(page)).toHaveText([
    /Who are you\?/,
    /A different answer\./,
  ]);
});

test('the last message can be deleted, and stays deleted', async ({ page }) => {
  await page.goto('/');
  await send(page, 'Who are you?');
  await expect(messages(page)).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete last message' }).click();
  await expect(messages(page)).toHaveText([/Who are you\?/]);

  await page.reload();
  await expect(messages(page)).toHaveText([/Who are you\?/]);

  await page.getByRole('button', { name: 'Delete last message' }).click();
  await expect(messages(page)).toHaveCount(0);
});

test('neither action is offered while a reply is streaming', async ({
  page,
  openai,
}) => {
  openai.respondWith(
    { kind: 'reply', chunks: ['The first answer.'] },
    {
      kind: 'reply',
      chunks: ['Slow', ' second', ' answer.'],
      chunkDelayMs: 400,
    },
  );
  await page.goto('/');
  await send(page, 'Who are you?');
  const regenerate = page.getByRole('button', { name: 'Regenerate' });
  const remove = page.getByRole('button', { name: 'Delete last message' });
  await expect(regenerate).toBeVisible();
  await expect(remove).toBeVisible();

  await send(page, 'And where are we?');
  await expect(messages(page).last()).toContainText('Slow');

  await expect(regenerate).toBeHidden();
  await expect(remove).toBeHidden();

  await expect(messages(page).last()).toContainText('Slow second answer.');
  await expect(regenerate).toBeVisible();
  await expect(remove).toBeVisible();
});

test('after a failed reply, trying again writes the reply', async ({
  page,
  openai,
}) => {
  openai.respondWith(
    { kind: 'disconnect' },
    { kind: 'reply', chunks: ['Here I am.'] },
  );
  await page.goto('/');
  await send(page, 'Hello?');
  await expect(page.getByRole('alert')).toContainText('Could not reach OpenAI');

  await page.getByRole('button', { name: 'Try again' }).click();

  await expect(messages(page)).toHaveText([/Hello\?/, /Here I am\./]);
  await expect(page.getByRole('alert')).toBeHidden();
});
