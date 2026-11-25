import { expect, test } from './fixtures.ts';
import { backToChat, openEmptyChat, send } from './helpers.ts';

test('the model is picked from the chat models OpenAI offers, with a thinking level', async ({
  page,
  openai,
}) => {
  await openEmptyChat(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  const level = page.getByRole('combobox', {
    name: 'Thinking level',
    exact: true,
  });

  // Pictures, speech, embeddings and dated snapshots are left out.
  await expect(model.getByRole('option')).toHaveText([
    'gpt-5.5',
    'gpt-5-mini',
    'gpt-4.1',
  ]);
  await expect(level.getByRole('option')).toHaveText([
    "The model's default",
    'None',
    'Low',
    'Medium',
    'High',
    'Extra high',
  ]);
  await model.selectOption('gpt-5-mini');
  await expect(level.getByRole('option')).toHaveText([
    "The model's default",
    'Minimal',
    'Low',
    'Medium',
    'High',
  ]);
  await level.selectOption('Minimal');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();

  await backToChat(page);
  await send(page, 'Hello?');
  await expect(page.getByText('Hello from the fake model.')).toBeVisible();

  expect(openai.requests[0]?.body).toMatchObject({
    model: 'gpt-5-mini',
    reasoning: { effort: 'minimal' },
  });
});

test('a thinking level the new model does not take goes back to the default', async ({
  page,
}) => {
  await page.goto('/#/settings');
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  const level = page.getByRole('combobox', {
    name: 'Thinking level',
    exact: true,
  });
  await expect(level).toBeEnabled();
  await level.selectOption('Extra high');

  await model.selectOption('gpt-5-mini');
  await expect(level).toHaveValue('');

  await model.selectOption('gpt-4.1');
  await expect(level).toBeDisabled();
  await expect(level).toHaveText('Not available for this model');
});

test("a model's thinking levels are found out once", async ({
  page,
  openai,
}) => {
  await page.goto('/#/settings');
  await expect(
    page.getByRole('combobox', { name: 'Scene thinking level', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('combobox', { name: 'Thinking level', exact: true }),
  ).toBeEnabled();
  const checks = openai.plainRequests.length;
  expect(checks).toBeGreaterThan(0);

  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Scene thinking level', exact: true }),
  ).toBeEnabled();

  expect(openai.plainRequests).toHaveLength(checks);
});

test.describe('with no API key', () => {
  test.use({ appEnv: { OPENAI_API_KEY: '' } });

  test('each model is typed, and the page says why it cannot be picked', async ({
    page,
  }) => {
    await page.goto('/#/settings');

    await expect(
      page.getByText(
        'The list of models could not be loaded, so type the name: No OpenAI API key is set.',
        { exact: false },
      ),
    ).toHaveCount(2);
    await expect(
      page.getByRole('textbox', { name: 'Model', exact: true }),
    ).toHaveValue('gpt-5.5');
  });
});
