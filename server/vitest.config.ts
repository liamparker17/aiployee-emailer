import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: [],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10000,
  },
});
