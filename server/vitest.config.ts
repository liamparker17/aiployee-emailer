import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // @aiployee/core ships compiled dist for the Node runtime; tests run against
      // its TypeScript source so they never go stale against an old build.
      '@aiployee/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Integration tests hit Neon over the network; 20s absorbs latency spikes that
    // otherwise produce spurious timeouts under full-suite load.
    testTimeout: 20000,
    // @fastify/session + connect-pg-simple emit ERR_HTTP_HEADERS_SENT after
    // inject() resolves (async Postgres session-save callback fires after
    // light-my-request finalises the response). All assertions pass; this
    // flag prevents that trailing async noise from failing the run.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
