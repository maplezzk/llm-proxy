import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    pool: 'forks',
  },
});
