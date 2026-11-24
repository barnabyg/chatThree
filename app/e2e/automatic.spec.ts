import { expect, test } from './fixtures.ts';
import {
  engineReady,
  giveMaraAPicture,
  messages,
  openLighthouseChat,
  send,
} from './helpers.ts';

const MOVED_TO_THE_LAMP_ROOM = {
  action: 'Mara lights the great lamp.',
  expression: 'intent',
  framing: 'wide shot',
  lighting: 'lamplight against the storm',
  moved: true,
  location: {
    name: 'The lamp room',
    description: 'A round glass room around the great lamp.',
  },
  worthIllustrating: true,
};

test('a reply that moves the story somewhere new is illustrated by itself', async ({
  page,
  app,
  openai,
}) => {
  openai.respondToStructuredWith({
    kind: 'json',
    value: MOVED_TO_THE_LAMP_ROOM,
  });
  await giveMaraAPicture(page);
  await openLighthouseChat(page);
  await engineReady(page);

  await send(page, 'Show me the lamp.');

  const reply = messages(page).nth(2);
  await expect(
    reply.getByRole('img', { name: 'Illustration 1 of this moment' }),
  ).toBeVisible();
  await expect(page.getByTestId('current-location')).toHaveText(
    'At The lamp room',
  );
  const painted = (await app.engineJobs()).filter(
    (job) => job.path === '/image',
  );
  expect(painted.map((job) => String(job.body.prompt))).toEqual([
    expect.stringContaining('A round glass room'),
    expect.stringContaining('Mara lights the great lamp.'),
  ]);
});

test('in Off mode nothing is illustrated by itself, the story is still followed, and the mode is kept', async ({
  page,
  app,
  openai,
}) => {
  openai.respondToStructuredWith({
    kind: 'json',
    value: MOVED_TO_THE_LAMP_ROOM,
  });
  await giveMaraAPicture(page);
  await page.goto('/#/settings');
  const mode = page.getByLabel('Illustrate replies by themselves');
  await expect(mode).toHaveValue('key-moments');
  await mode.selectOption({ label: 'Off' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();
  await page.reload();
  await expect(mode).toHaveValue('off');

  await openLighthouseChat(page);
  await engineReady(page);
  await send(page, 'Show me the lamp.');
  await expect(messages(page)).toHaveCount(3);
  // The scene call still follows the story to the lamp room.
  await expect(page.getByTestId('current-location')).toHaveText(
    'At The lamp room',
  );
  await send(page, 'It is bright.');
  await expect(messages(page)).toHaveCount(5);
  await expect.poll(() => openai.structuredRequests.length).toBe(2);

  expect(
    (await app.engineJobs()).filter((job) => job.path === '/image'),
  ).toEqual([]);
  await expect(page.getByRole('img', { name: /Illustration/ })).toHaveCount(0);
});
