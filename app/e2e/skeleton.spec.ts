import { expect, test } from './fixtures.ts';

test('the UI loads and shows the placeholder page', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'chatThree' })).toBeVisible();
  await expect(page.getByText('The app is running.')).toBeVisible();
});
