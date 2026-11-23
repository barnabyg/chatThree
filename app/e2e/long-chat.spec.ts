import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

// Estimated at 53 tokens: 196 characters / 4, plus 4.
const long = (label: string): string => label.padEnd(196, '.');
// The fake's default reply, estimated at 11 tokens.
const REPLY = 'Hello from the fake model.';

test('a chat over the token budget stops sending its oldest messages, but keeps and shows them all', async ({
  page,
  openai,
}) => {
  await page.goto('/#/settings');
  await page.getByLabel('Conversation budget (tokens)').fill('100');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Chat' }).click();

  const items = page
    .getByRole('list', { name: 'Conversation' })
    .getByRole('listitem');
  await send(page, long('first message'));
  await expect(items).toHaveCount(2);
  await send(page, long('second message'));
  await expect(items).toHaveCount(4);
  await send(page, long('third message'));

  // Everything is still shown, with a line where sending now starts:
  // the last three messages (11 + 53 + 11 tokens) fit in 100, a fourth does not.
  await expect(items).toHaveText([
    /first message/,
    /Hello from the fake model/,
    /second message/,
    'Messages above this line are no longer sent to the model.',
    /Hello from the fake model/,
    /third message/,
    /Hello from the fake model/,
  ]);

  // The third request carried only what fitted, after the unchanged prefix.
  const [first, , third] = openai.requests.map((request) => request.body);
  expect(third?.input).toEqual([
    { role: 'assistant', content: REPLY },
    { role: 'user', content: long('third message') },
  ]);
  expect(third?.instructions).toBe(first?.instructions);

  // The line is still there after a reload.
  await page.reload();
  await expect(items).toHaveCount(7);
  await expect(items.nth(3)).toHaveText(/no longer sent/);
});
