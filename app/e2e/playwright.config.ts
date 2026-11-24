import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  // Every test starts its own app on its own port and data directory
  // (see e2e/fixtures.ts), so tests can run in parallel.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // CI stops at the first failure; local runs report every failure.
  maxFailures: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
