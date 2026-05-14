import PgBoss from 'pg-boss';
import type { Config } from './config.js';

let boss: PgBoss | null = null;

export async function startBoss(cfg: Config): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: cfg.databaseUrl, schema: 'pgboss' });
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) { await boss.stop({ graceful: true }); boss = null; }
}

export function getBoss(): PgBoss {
  if (!boss) throw new Error('pg-boss not started');
  return boss;
}
