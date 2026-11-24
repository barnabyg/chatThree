import type { Locator, Page } from '@playwright/test';

interface Created {
  id: string;
}

/** The messages on the chat page, oldest first. */
export function messages(page: Page): Locator {
  return page.getByRole('list', { name: 'Conversation' }).getByRole('listitem');
}

export async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** Create something through the app's API and return it. */
export async function create<T extends Created>(
  page: Page,
  url: string,
  data: object,
): Promise<T> {
  const response = await page.request.post(url, { data });
  if (!response.ok()) {
    throw new Error(`POST ${url} failed: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * Open a new chat with the built-in character, set in a scenario with no
 * opening message, so that the conversation starts empty. For tests that are
 * about the conversation and not about how a chat is started.
 */
export async function openEmptyChat(page: Page): Promise<void> {
  const characters = (await (
    await page.request.get('/api/characters')
  ).json()) as Created[];
  const scenario = await create(page, '/api/scenarios', {
    title: 'An empty room',
  });
  const chat = await create(page, '/api/chats', {
    characterId: characters[0]?.id,
    scenarioId: scenario.id,
  });
  await page.goto(`/#/chats/${chat.id}`);
}

/** Go to the most recently active chat, by its link in the chat list. */
export async function backToChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Chats' })
    .getByRole('link')
    .first()
    .click();
}
