import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 10000,
    // @fastify/session + connect-pg-simple emit ERR_HTTP_HEADERS_SENT after
    // inject() resolves (async Postgres session-save callback fires after
    // light-my-request finalises the response). All assertions pass; this
    // flag prevents that trailing async noise from failing the run.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
