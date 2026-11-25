import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  engineReady,
  openEmptyChat,
  playback,
  send,
  watchPlayback,
} from './helpers.ts';

function conversation(page: Page) {
  return page.getByRole('list', { name: 'Conversation' });
}

/** The reply that is still being written, if there is one. */
function arriving(page: Page) {
  return conversation(page).locator('[aria-busy="true"]');
}

test('a reply is spoken a sentence at a time, in order, starting before the reply has all arrived', async ({
  page,
  openai,
  app,
}) => {
  openai.respondWith({
    kind: 'reply',
    chunks: [
      'She looks you over. "Come in. ',
      'Sit by the stove." She bolts the door.',
      ' "You can tell me why you are here',
      ' when you have stopped shaking."',
    ],
    // The second half waits until the test has looked at the first.
    holdAfter: 2,
  });
  await watchPlayback(page);
  await openEmptyChat(page);
  await engineReady(page);

  await send(page, 'Hello? Is anyone there?');

  // The first sentences are sent to be spoken while the rest is being written.
  await expect
    .poll(() => app.spoken())
    .toEqual(['Come in.', 'Sit by the stove.']);
  // And the first of them is heard: sound has started.
  await expect
    .poll(async () => (await playback(page)).started)
    .toBeGreaterThan(0);
  await expect(arriving(page)).toBeVisible();
  await expect(arriving(page)).not.toContainText('stopped shaking');

  openai.release();

  await expect(arriving(page)).toBeHidden();
  await expect
    .poll(() => app.spoken())
    .toEqual([
      'Come in.',
      'Sit by the stove.',
      'You can tell me why you are here when you have stopped shaking.',
    ]);
  // Every clip is played to its end, one at a time, after which there is
  // nothing to stop.
  await expect
    .poll(() => playback(page))
    .toEqual({ started: 3, finished: 3, halted: 0 });
  await expect(
    page.getByRole('button', { name: 'Stop speaking' }),
  ).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Speech' }),
  ).toHaveCount(0);
});

test('the whole reply is spoken when the setting says so, without its formatting marks', async ({
  page,
  openai,
  app,
}) => {
  openai.respondWith({
    kind: 'reply',
    chunks: ['*She pours the tea.* "Drink," she says. **Now.**'],
  });
  await page.goto('/#/settings');
  await page
    .getByLabel('What is spoken')
    .selectOption({ label: 'The whole reply' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();
  await engineReady(page);

  await openEmptyChat(page);
  await send(page, 'Hello?');

  await expect
    .poll(() => app.spoken())
    .toEqual(['She pours the tea.', 'Drink, she says.', 'Now.']);
});

test('text too long for one request is split before it is sent to the engine', async ({
  page,
  openai,
  app,
}) => {
  const clause = 'and the tide came in over the flats as it always had';
  const long = `"${Array.from({ length: 20 }, () => clause).join(', ')}."`;
  expect(long.length).toBeGreaterThan(600);
  openai.respondWith({ kind: 'reply', chunks: [long] });
  await openEmptyChat(page);
  await engineReady(page);

  await send(page, 'Tell me about the tide.');

  await expect.poll(async () => (await app.spoken()).length).toBe(2);
  const spoken = await app.spoken();
  for (const piece of spoken) expect(piece.length).toBeLessThanOrEqual(600);
  expect(spoken.join(' ')).toBe(long.slice(1, -1));
});

test.describe('with clips that take a while to play', () => {
  test.use({ appEnv: { FAKE_ENGINE_CLIP_MS: '20000' } });

  test('stopping halts the clip being played and cancels the ones not yet played', async ({
    page,
    openai,
    app,
  }) => {
    openai.respondWith({
      kind: 'reply',
      chunks: ['"The lamp is lit. The door is barred. Now we wait."'],
    });
    await watchPlayback(page);
    await openEmptyChat(page);
    await engineReady(page);
    await send(page, 'What now?');
    const stop = page.getByRole('button', { name: 'Stop speaking' });
    await expect(stop).toBeVisible();
    // All three clips are made while the first, a long one, is playing.
    await expect.poll(async () => (await app.spoken()).length).toBe(3);
    await expect.poll(() => playback(page)).toMatchObject({ started: 1 });

    await stop.click();

    await expect(stop).toBeHidden();
    // The clip that was playing is halted, and the two after it never start.
    await expect
      .poll(() => playback(page))
      .toEqual({ started: 1, finished: 0, halted: 1 });
    await page.waitForTimeout(500);
    expect(await playback(page)).toEqual({
      started: 1,
      finished: 0,
      halted: 1,
    });
    // The text of the reply is untouched.
    await expect(conversation(page)).toContainText('Now we wait.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});

test('muting stops replies being spoken, and is remembered after a reload', async ({
  page,
  app,
}) => {
  await openEmptyChat(page);
  await engineReady(page);
  const speak = page.getByRole('checkbox', { name: 'Speak replies' });
  await expect(speak).toBeChecked();

  await speak.uncheck();
  await page.reload();
  await expect(speak).not.toBeChecked();

  await send(page, 'Hello?');
  await expect(conversation(page)).toContainText('Hello from the fake model.');
  expect(await app.spoken()).toEqual([]);

  // Unmuted, the next reply is spoken again.
  await speak.check();
  await send(page, 'Hello again?');
  await expect.poll(() => app.spoken()).toEqual(['Hello from the fake model.']);
});

test.describe('with an engine that is not ready', () => {
  test.use({ appEnv: { FAKE_ENGINE_MODE: 'failed' } });

  test('the reply still arrives as text, and the chat says speech is unavailable', async ({
    page,
  }) => {
    await openEmptyChat(page);

    await send(page, 'Hello?');

    await expect(conversation(page)).toContainText(
      'Hello from the fake model.',
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'Speech' }),
    ).toHaveText('Speech is unavailable because the engine is not ready.');
    // The chat carries on.
    await send(page, 'Are you there?');
    await expect(conversation(page).getByRole('listitem')).toHaveCount(4);
  });
});

test.describe('with a sentence the engine cannot speak', () => {
  test.use({ appEnv: { FAKE_ENGINE_SPEECH_FAILS: 'reef' } });

  test('the chat says speech is unavailable and keeps the reply', async ({
    page,
    openai,
    app,
  }) => {
    openai.respondWith({
      kind: 'reply',
      chunks: ['"Mind the reef. It has taken better boats than yours."'],
    });
    await openEmptyChat(page);
    await engineReady(page);

    await send(page, 'Is it safe to sail?');

    await expect(
      page.getByRole('status').filter({ hasText: 'Speech' }),
    ).toHaveText('Speech is unavailable: the engine could not speak that.');
    await expect(conversation(page)).toContainText('better boats than yours');
    // Nothing after the sentence that failed is asked for.
    expect(await app.spoken()).toEqual(['Mind the reef.']);
  });
});

test('a character message can be replayed, even with speech muted', async ({
  page,
  openai,
  app,
}) => {
  openai.respondWith({
    kind: 'reply',
    chunks: ['"The ferry leaves at dawn." She folds the map.'],
  });
  await openEmptyChat(page);
  await engineReady(page);
  await send(page, 'When do we sail?');
  await expect.poll(() => app.spoken()).toEqual(['The ferry leaves at dawn.']);

  // The user's own messages have nothing to replay.
  const replay = conversation(page).getByRole('button', {
    name: 'Replay message',
  });
  await expect(replay).toHaveCount(1);

  await page.getByRole('checkbox', { name: 'Speak replies' }).uncheck();
  await replay.click();

  await expect
    .poll(() => app.spoken())
    .toEqual(['The ferry leaves at dawn.', 'The ferry leaves at dawn.']);
});
