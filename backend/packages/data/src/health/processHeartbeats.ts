import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import type { Queryable } from "../db/pool.js";

export const PROCESS_HEARTBEAT_INTERVAL_MS = 15_000;

/** Used by `GET /healthz` and the expected-rows derivation. */
export const PROCESS_HEARTBEAT_STALE_AFTER_MS = 60_000;

/** Processes independent of per-item activity; `mailsync:<id>` rows are derived per active mailbox. */
export const FIXED_PROCESS_NAMES = ["api", "agents", "transcribe", "ai-gateway"] as const;

export function mailSyncProcessName(mailboxItemId: string): string {
  return `mailsync:${mailboxItemId}`;
}

export interface ProcessHeartbeatIdentity {
  process: string;
  pid: number;
  version: string;
}

/** `startedAt` is passed in so repeated ticks keep one `started_at`; otherwise the process would look like it keeps restarting. */
export async function upsertProcessHeartbeat(
  client: Queryable,
  identity: ProcessHeartbeatIdentity,
  startedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO process_heartbeats (process, pid, version, started_at, beat_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (process) DO UPDATE SET
       pid = excluded.pid,
       version = excluded.version,
       started_at = excluded.started_at,
       beat_at = excluded.beat_at`,
    [identity.process, identity.pid, identity.version, startedAt],
  );
}

export interface ProcessHeartbeatOptions {
  intervalMs?: number;
  /** A transient DB error must not throw out of the interval and crash the process. */
  onError?: (err: unknown) => void;
}

export interface ProcessHeartbeatHandle {
  stop(): void;
}

/** Ticks immediately, then on `intervalMs`. `stop()` never deletes the row, so `beat_at` simply goes stale. */
export function startProcessHeartbeat(
  pool: Pool,
  identity: ProcessHeartbeatIdentity,
  options: ProcessHeartbeatOptions = {},
): ProcessHeartbeatHandle {
  const intervalMs = options.intervalMs ?? PROCESS_HEARTBEAT_INTERVAL_MS;
  const startedAt = new Date();

  function tick(): void {
    // Global table, so a system scope. Entering the scope can throw synchronously; that must reach `onError`.
    try {
      runAsSystem("processHeartbeat", () => upsertProcessHeartbeat(pool, identity, startedAt)).catch((err: unknown) => {
        options.onError?.(err);
      });
    } catch (err) {
      options.onError?.(err);
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Joins live Mailbox items: a soft-deleted Mailbox's sync-state row is never cleaned up and would alert forever. */
export async function getActiveMailSyncProcessNames(client: Queryable): Promise<string[]> {
  const result = await client.query<{ item_id: string }>(
    `SELECT s.item_id FROM mail_account_sync_state s
     JOIN items i ON i.id = s.item_id AND i.database_id = ANY($1::uuid[])
     WHERE i.deleted_at IS NULL`,
    [await visibleDatabaseIds(client)],
  );
  return result.rows.map((row) => mailSyncProcessName(row.item_id));
}

export async function getExpectedProcessNames(client: Queryable): Promise<string[]> {
  const mailSyncNames = await getActiveMailSyncProcessNames(client);
  return [...FIXED_PROCESS_NAMES, ...mailSyncNames];
}

export interface ProcessHeartbeatStatus {
  process: string;
  present: boolean;
  stale: boolean;
  beatAt: string | null;
}

/** A mailbox deactivated since its last beat is no longer expected, so its old row is not reported. */
export async function getExpectedProcessHeartbeatStatuses(
  client: Queryable,
  options: { staleAfterMs?: number } = {},
): Promise<ProcessHeartbeatStatus[]> {
  const staleAfterMs = options.staleAfterMs ?? PROCESS_HEARTBEAT_STALE_AFTER_MS;
  const expected = await getExpectedProcessNames(client);
  if (expected.length === 0) return [];

  const result = await client.query<{ process: string; beat_at: Date }>(
    "SELECT process, beat_at FROM process_heartbeats WHERE process = ANY($1)",
    [expected],
  );
  const beatAtByProcess = new Map(result.rows.map((row) => [row.process, row.beat_at]));
  const now = Date.now();

  return expected.map((process) => {
    const beatAt = beatAtByProcess.get(process) ?? null;
    const stale = beatAt === null || now - beatAt.getTime() > staleAfterMs;
    return { process, present: beatAt !== null, stale, beatAt: beatAt?.toISOString() ?? null };
  });
}

export async function isProcessHeartbeatFresh(
  client: Queryable,
  process: string,
  options: { staleAfterMs?: number } = {},
): Promise<boolean> {
  const staleAfterMs = options.staleAfterMs ?? PROCESS_HEARTBEAT_STALE_AFTER_MS;
  const result = await client.query<{ beat_at: Date }>("SELECT beat_at FROM process_heartbeats WHERE process = $1", [
    process,
  ]);
  const row = result.rows[0];
  if (!row) return false;
  return Date.now() - row.beat_at.getTime() <= staleAfterMs;
}
