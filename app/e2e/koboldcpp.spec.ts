import { FAKE_KOBOLDCPP_MODEL } from '../test-support/fake-koboldcpp.ts';
import { expect, test } from './fixtures.ts';
import { engineReady, messages, openEmptyChat, send } from './helpers.ts';

test('with KoboldCpp as the text backend, the connection is tested and replies come from it, spoken as they arrive', async ({
  page,
  app,
  openai,
  kobold,
}) => {
  kobold.respondWith({
    kind: 'reply',
    reasoning: ['The traveller wants', ' shelter.'],
    chunks: ['"Come in.', ' Sit by the stove."'],
  });
  await page.goto('/#/settings/connection');
  await page.getByLabel('Text backend').selectOption({ label: 'KoboldCpp' });

  // The OpenAI fields give way to KoboldCpp's.
  await expect(page.getByLabel('OpenAI API key')).toHaveCount(0);
  await expect(page.getByLabel('Thinking level')).toHaveCount(0);
  await page.getByLabel('Server address').fill(kobold.address);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').getByText(/^Connected/)).toHaveText(
    `Connected. ${FAKE_KOBOLDCPP_MODEL} is loaded, with a context of 8,192 tokens.`,
  );
  await expect(page.getByLabel('Loaded model')).toHaveValue(
    FAKE_KOBOLDCPP_MODEL,
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();

  // The scene model is not KoboldCpp's to choose either.
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Images' })
    .click();
  await expect(page.getByLabel('Scene model')).toHaveCount(0);

  // The choice survives a reload, and the loaded model is shown.
  await page.goto('/#/settings/connection');
  await expect(page.getByLabel('Text backend')).toHaveValue('koboldcpp');
  await expect(page.getByLabel('Loaded model')).toHaveValue(
    FAKE_KOBOLDCPP_MODEL,
  );

  await openEmptyChat(page);
  await engineReady(page);
  await send(page, 'Hello? Is anyone there?');

  await expect(messages(page)).toHaveText([
    /Hello\? Is anyone there\?/,
    /Mara Quill\s*"Come in\. Sit by the stove\."/,
  ]);
  await expect
    .poll(() => app.spoken())
    .toEqual(['Come in.', 'Sit by the stove.']);
  expect(kobold.requests).toHaveLength(1);
  expect(openai.requests).toHaveLength(0);
});

test('a KoboldCpp that cannot be reached is named in the error', async ({
  page,
  kobold,
}) => {
  const address = kobold.address;
  await kobold.close();
  await page.goto('/#/settings/connection');
  await page.getByLabel('Text backend').selectOption({ label: 'KoboldCpp' });
  await page.getByLabel('Server address').fill(address);

  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByRole('alert')).toContainText(
    `Could not reach KoboldCpp at ${address}`,
  );
});
