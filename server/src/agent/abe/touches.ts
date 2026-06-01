import type pg from 'pg';
import type { PlayRow } from '../../repos/agentPlays.js';
import type { Sender } from '../../repos/senders.js';
import { queuePlayTouch } from './execute.js';

// Advance ONE executing play to its next due touch. nextIndex = number of outcome rows already recorded.
export async function advancePlayTouches(args: {
  pool: pg.Pool; encKey: Buffer; baseUrl: string; play: PlayRow; touchSpacingDays: number; sender: Sender;
}): Promise<{ done: boolean; due: boolean; queued: number; touchIndex: number | null }> {
  const { pool, encKey, baseUrl, play, touchSpacingDays, sender } = args;
  const cnt = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_play_outcomes WHERE play_id = $1`, [play.id]);
  const nextIndex = Number(cnt.rows[0].n);

  if (nextIndex >= play.touches.length) {
    await pool.query(`UPDATE agent_plays SET status = 'done', updated_at = now() WHERE id = $1`, [play.id]);
    return { done: true, due: false, queued: 0, touchIndex: null };
  }
  const executedAt = play.executed_at ? new Date(play.executed_at).getTime() : 0;
  const dueAt = executedAt + nextIndex * touchSpacingDays * 24 * 3600 * 1000;
  if (Date.now() < dueAt) return { done: false, due: false, queued: 0, touchIndex: nextIndex };

  const reengagedSince = play.executed_at ? new Date(play.executed_at) : null;
  const { queued } = await queuePlayTouch({ pool, encKey, baseUrl, play, touchIndex: nextIndex, sender, reengagedSince });

  let done = false;
  if (nextIndex + 1 >= play.touches.length) {
    await pool.query(`UPDATE agent_plays SET status = 'done', updated_at = now() WHERE id = $1`, [play.id]);
    done = true;
  }
  return { done, due: true, queued, touchIndex: nextIndex };
}
