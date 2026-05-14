import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().nonnegative().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  EMAILER_ENC_KEY: z.string().refine(
    s => Buffer.from(s, 'base64').length === 32,
    'EMAILER_ENC_KEY must be 32 bytes base64-encoded'
  ),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.string().default('info'),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be ≥16 chars').default('PLACEHOLDER_REPLACE_IN_VERCEL_ENV_VARS'),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  encKey: Buffer;
  publicBaseUrl: string;
  logLevel: string;
  cronSecret: string;
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const p = Schema.parse(env);
  return {
    env: p.NODE_ENV,
    port: p.PORT,
    databaseUrl: p.DATABASE_URL,
    sessionSecret: p.SESSION_SECRET,
    encKey: Buffer.from(p.EMAILER_ENC_KEY, 'base64'),
    publicBaseUrl: p.PUBLIC_BASE_URL,
    logLevel: p.LOG_LEVEL,
    cronSecret: p.CRON_SECRET,
  };
}
