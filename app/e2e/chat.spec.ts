import type { Page } from '@playwright/test';
import { FAKE_API_KEY } from '../test-support/fake-openai.ts';
import { expect, test } from './fixtures.ts';
import { backToChat, openEmptyChat, send } from './helpers.ts';

function conversation(page: Page) {
  return page.getByRole('list', { name: 'Conversation' });
}

test('a message gets a streamed reply, and the conversation survives a reload', async ({
  page,
  openai,
}) => {
  openai.respondWith({
    kind: 'reply',
    chunks: ['Come in', ' out of', ' the rain.'],
  });
  await openEmptyChat(page);
  await expect(page.getByRole('heading', { name: 'Mara Quill' })).toBeVisible();

  await send(page, 'Hello? Is anyone there?');

  const messages = conversation(page).getByRole('listitem');
  await expect(messages).toHaveText([
    /You\s*Hello\? Is anyone there\?/,
    /Mara Quill\s*Come in out of the rain\./,
  ]);

  await page.reload();

  await expect(messages).toHaveText([
    /Hello\? Is anyone there\?/,
    /Come in out of the rain\./,
  ]);
});

test('OpenAI is sent the character, then the scenario, then the conversation', async ({
  page,
  openai,
}) => {
  await openEmptyChat(page);
  await send(page, 'Hello?');
  await expect(conversation(page)).toContainText('Hello from the fake model.');
  await send(page, 'Who are you?');
  await expect(conversation(page).getByRole('listitem')).toHaveCount(4);

  const [first, second] = openai.requests.map((request) => request.body);
  expect(second?.instructions).toBe(first?.instructions);
  expect(second?.instructions.indexOf('Mara Quill')).toBeLessThan(
    second?.instructions.indexOf('An empty room') ?? -1,
  );
  expect(second?.input).toEqual([
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Hello from the fake model.' },
    { role: 'user', content: 'Who are you?' },
  ]);
});

test('a reply appears piece by piece and can be stopped part-way', async ({
  page,
  openai,
}) => {
  openai.respondWith({
    kind: 'reply',
    chunks: [
      'The lamp',
      ' is lit,',
      ' and',
      ' the',
      ' door',
      ' is',
      ' barred.',
    ],
    chunkDelayMs: 400,
  });
  await openEmptyChat(page);

  await send(page, 'What do you see?');
  const reply = conversation(page).getByRole('listitem').nth(1);
  await expect(reply).toContainText('The lamp');
  await expect(reply).not.toContainText('barred');

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(reply).not.toContainText('barred');
  await expect.poll(() => openai.requests[0]?.abandoned).toBe(true);

  // What had arrived is kept as the reply.
  await page.reload();
  await expect(reply).toContainText('The lamp');
  await expect(reply).not.toContainText('barred');
});

test.describe('with no API key', () => {
  test.use({ appEnv: { OPENAI_API_KEY: '' } });

  test('the chat says a key is needed, keeps the message, and works once a key is saved in Settings', async ({
    page,
  }) => {
    await openEmptyChat(page);
    await send(page, 'Hello?');

    await expect(page.getByRole('alert')).toContainText(
      'No OpenAI API key is set',
    );
    await expect(conversation(page)).toContainText('Hello?');

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByTestId('key-source')).toHaveText(/No key is set/);
    await page.getByLabel('OpenAI API key').fill(FAKE_API_KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('key-source')).toHaveText(
      'Using the key saved here.',
    );

    // The saved key is never sent back to the browser.
    await expect(page.getByLabel('OpenAI API key')).toHaveValue('');
    const settings = await page.request.get('/api/settings');
    expect(await settings.text()).not.toContain(FAKE_API_KEY);

    await backToChat(page);
    await expect(conversation(page)).toContainText('Hello?');
    await send(page, 'Hello again?');
    await expect(conversation(page)).toContainText(
      'Hello from the fake model.',
    );
  });
});

test.describe('with an API key OpenAI rejects', () => {
  test.use({ appEnv: { OPENAI_API_KEY: 'sk-not-the-right-key' } });

  test('the chat says the key was rejected and keeps the message', async ({
    page,
  }) => {
    await openEmptyChat(page);
    await send(page, 'Hello?');

    await expect(page.getByRole('alert')).toHaveText(
      'OpenAI rejected the API key. Check the key in Settings.',
    );

    await page.reload();
    await expect(conversation(page).getByRole('listitem')).toHaveText([
      /Hello\?/,
    ]);
  });
});

test('a network failure is reported in the chat and the message is kept', async ({
  page,
  openai,
}) => {
  openai.respondWith({ kind: 'disconnect' });
  await openEmptyChat(page);

  await send(page, 'Hello?');

  await expect(page.getByRole('alert')).toContainText('Could not reach OpenAI');
  await expect(conversation(page).getByRole('listitem')).toHaveText([
    /Hello\?/,
  ]);
});

test('a message the app could not take stays in the message box', async ({
  page,
  app,
}) => {
  await openEmptyChat(page);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await app.stop();

  await send(page, 'Do not lose this.');

  await expect(page.getByRole('alert')).toContainText(
    'chatThree is not running',
  );
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Do not lose this.',
  );
});

test('a refusal is reported in the chat with the reason given', async ({
  page,
  openai,
}) => {
  openai.respondWith({ kind: 'refusal', text: "I can't continue this story." });
  await openEmptyChat(page);

  await send(page, 'Hello?');

  await expect(page.getByRole('alert')).toHaveText(
    "The model declined to reply: I can't continue this story.",
  );
  await expect(conversation(page).getByRole('listitem')).toHaveText([
    /Hello\?/,
  ]);
});

test('the model is a setting, with a default', async ({ page, openai }) => {
  await page.goto('/#/settings');
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).not.toHaveValue('');
  const defaultModel = await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .inputValue();

  await openEmptyChat(page);
  await send(page, 'Hello?');
  await expect(conversation(page)).toContainText('Hello from the fake model.');

  await page.getByRole('link', { name: 'Settings' }).click();
  await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('gpt-5-mini');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();

  await backToChat(page);
  await send(page, 'Hello again?');
  await expect(conversation(page).getByRole('listitem')).toHaveCount(4);

  expect(openai.requests.map((request) => request.body.model)).toEqual([
    defaultModel,
    'gpt-5-mini',
  ]);
});

test('the chat header says which text backend writes the replies', async ({
  page,
}) => {
  await openEmptyChat(page);
  await expect(page.getByTestId('text-backend')).toHaveText(
    'Text: OpenAI · gpt-5.5',
  );
});

test('a suggested reply length set in Settings is sent to the model', async ({
  page,
  openai,
}) => {
  await page.goto('/#/settings/text');
  await page.getByLabel('Suggested reply length (words)').fill('90');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();

  await openEmptyChat(page);
  await send(page, 'Hello?');
  await expect(conversation(page)).toContainText('Hello from the fake model.');

  expect(openai.requests.at(-1)?.body.instructions).toMatch(
    /Keep each reply to about 90 words\.$/,
  );
});
