import { expect, test } from './fixtures.ts';

test('the UI loads', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('chatThree');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});
