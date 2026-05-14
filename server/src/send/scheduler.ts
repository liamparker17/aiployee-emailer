import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { logger } from '../util/logger.js';

export async function pollDueScheduled(args: { pool: pg.Pool; boss: PgBoss }): Promise<number> {
  const r = await args.pool.query<{ id: string }>(
    `SELECT id FROM emails
     WHERE status = 'queued' AND scheduled_for IS NOT NULL AND scheduled_for <= now()
     ORDER BY scheduled_for ASC LIMIT 200`);
  for (const row of r.rows) {
    await args.boss.send('send-email', { emailId: row.id });
  }
  if (r.rowCount && r.rowCount > 0) logger.info({ count: r.rowCount }, 'scheduler enqueued due emails');
  return r.rowCount ?? 0;
}

export function startScheduler(args: { pool: pg.Pool; boss: PgBoss; intervalMs?: number }): () => void {
  const interval = args.intervalMs ?? 30_000;
  const t = setInterval(() => {
    pollDueScheduled(args).catch(err => logger.error({ err }, 'scheduler tick failed'));
  }, interval);
  return () => clearInterval(t);
}
