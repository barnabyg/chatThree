import { expect, type Locator, type Page } from '@playwright/test';
import { solidPng } from '../test-support/png.ts';

interface Created {
  id: string;
}

/** Wait until the page shows the engine as ready to take jobs. */
export async function engineReady(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Engine' })).toContainText(
    'Engine ready',
  );
}

/** Open the built-in character in the character editor. */
export async function editMara(page: Page): Promise<void> {
  await page.goto('/#/characters');
  await page.getByRole('link', { name: 'Edit Mara Quill' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit character' }),
  ).toBeVisible();
}

/** What the page has done with sound: see `watchPlayback`. */
export interface Playback {
  /** How many clips have been started. */
  started: number;
  /** How many of those played to their end. */
  finished: number;
  /** How many were halted before their end. */
  halted: number;
}

/**
 * Count the clips the page plays, from before it loads. Call before the
 * first `goto`; read the counts with `playback`.
 */
export async function watchPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts = { started: 0, finished: 0, halted: 0 };
    Object.assign(window, { playbackCounts: counts });
    const play = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'play',
    )?.value as (this: HTMLMediaElement) => Promise<void>;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      counts.started += 1;
      this.addEventListener('ended', () => (counts.finished += 1));
      this.addEventListener('pause', () => {
        if (!this.ended) counts.halted += 1;
      });
      return play.call(this);
    };
  });
}

export function playback(page: Page): Promise<Playback> {
  return page.evaluate(
    () => (window as unknown as { playbackCounts: Playback }).playbackCounts,
  );
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

/** Give the built-in character a reference picture, through the app's API. */
export async function giveMaraAPicture(page: Page): Promise<void> {
  const [mara] = (await (
    await page.request.get('/api/characters')
  ).json()) as Created[];
  const response = await page.request.put(
    `/api/characters/${mara?.id ?? ''}/image`,
    {
      headers: { 'Content-Type': 'application/octet-stream' },
      data: Buffer.from(solidPng(24, 32, [200, 40, 40])),
    },
  );
  expect(response.ok()).toBe(true);
}

/**
 * Open a new chat with the built-in character in the built-in scenario, which
 * begins with Mara's opening message in the lighthouse kitchen.
 */
export async function openLighthouseChat(page: Page): Promise<void> {
  const [mara] = (await (
    await page.request.get('/api/characters')
  ).json()) as Created[];
  const [storm] = (await (
    await page.request.get('/api/scenarios')
  ).json()) as Created[];
  const response = await page.request.post('/api/chats', {
    data: { characterId: mara?.id, scenarioId: storm?.id },
  });
  const chat = (await response.json()) as Created;
  await page.goto(`/#/chats/${chat.id}`);
}
