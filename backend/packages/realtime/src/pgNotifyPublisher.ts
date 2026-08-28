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

/**
 * Postgres caps a NOTIFY payload at ~8000 bytes; a `doc_update` message whose
 * base64-encoded Yjs update doesn't fit will reject here. That only drops the live
 * push — the update itself is already durably committed to `doc_updates` before this
 * is called (see docPersistence.ts's appendDocUpdate), so a client that misses the
 * live frame still converges by reloading the doc. Chunking oversized frames is
 * deliberately not built here — out of scope for the "minimal fan-out" this issue asks
 * for; revisit if large pastes/bulk agent writes make this a real-world problem.
 */
export async function publishRealtimeMessage(pool: Pool, message: RealtimeMessage): Promise<void> {
  await pool.query(`SELECT pg_notify($1, $2)`, [REALTIME_CHANNEL, JSON.stringify(message)]);
}
