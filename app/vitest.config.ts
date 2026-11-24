import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Test files run in parallel workers by default.
    // CI stops at the first failure; local runs report every failure.
    bail: process.env.CI ? 1 : 0,
  },
});
