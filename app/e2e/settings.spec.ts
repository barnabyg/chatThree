import { expect, test } from './fixtures.ts';

test('Settings is in tabs, which keep unsaved changes until Save saves them all', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  const tabs = page.getByRole('navigation', { name: 'Settings' });
  await expect(tabs.getByRole('link')).toHaveText([
    'Connection',
    'Text',
    'Images',
    'Speech',
    'Reply prompts',
  ]);
  // Connection is the first tab, and holds only its own settings.
  await expect(tabs.getByRole('link', { name: 'Connection' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('OpenAI API key')).toBeVisible();
  await expect(page.getByLabel('Picture style')).toHaveCount(0);

  await tabs.getByRole('link', { name: 'Images' }).click();
  await page.getByLabel('Cooldown (replies)').fill('7');
  await tabs.getByRole('link', { name: 'Speech' }).click();
  await page
    .getByLabel('What is spoken')
    .selectOption({ label: 'The whole reply' });
  await tabs.getByRole('link', { name: 'Images' }).click();
  await expect(page.getByLabel('Cooldown (replies)')).toHaveValue('7');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();

  // The tab is in the address, so a reload stays on it.
  await page.reload();
  await expect(page.getByLabel('Cooldown (replies)')).toHaveValue('7');
  await tabs.getByRole('link', { name: 'Speech' }).click();
  await expect(page.getByLabel('What is spoken')).toHaveValue('everything');

  await tabs.getByRole('link', { name: 'Reply prompts' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Reply prompts' })).toBeVisible();
});
