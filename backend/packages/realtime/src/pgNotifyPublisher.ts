import type { Pool } from "pg";

/**
 * One channel for every realtime message kind — structured-data invalidation and
 * binary CRDT update frames are distinguished only by `type` on this shared channel,
 * not by separate mechanisms (issue #23, point 8).
 */
export const REALTIME_CHANNEL = "semprec_realtime";

export type RealtimeMessage =
  | { type: "item_invalidation"; databaseId: string; itemId: string; key: string }
  | { type: "doc_update"; docId: string; update: string; createdBy: string };

export async function publishRealtimeMessage(pool: Pool, message: RealtimeMessage): Promise<void> {
  await pool.query(`SELECT pg_notify($1, $2)`, [REALTIME_CHANNEL, JSON.stringify(message)]);
}
