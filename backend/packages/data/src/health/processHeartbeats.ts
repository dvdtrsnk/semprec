import type { Pool } from "pg";
import type { Queryable } from "../db/pool.js";

/** How often a running process re-UPSERTs its own identity row (issue #168's Task). */
export const PROCESS_HEARTBEAT_INTERVAL_MS = 15_000;

/** A row older than this is stale — used both by `GET /healthz` and by the expected-rows derivation. */
export const PROCESS_HEARTBEAT_STALE_AFTER_MS = 60_000;

/**
 * The four process types that exist independently of any per-item activity. `mailsync:<id>`
 * rows are derived instead, one per row in `mail_account_sync_state` (issue #168's Task:
 * "Derive expected rows as four fixed processes plus active mailboxes").
 */
export const FIXED_PROCESS_NAMES = ["api", "agents", "transcribe", "ai-gateway"] as const;

export function mailSyncProcessName(mailboxItemId: string): string {
  return `mailsync:${mailboxItemId}`;
}

export interface ProcessHeartbeatIdentity {
  process: string;
  pid: number;
  version: string;
}

/**
 * UPSERTs one process's identity row. `startedAt` is passed in rather than computed here so a
 * running process's repeated ticks (`startProcessHeartbeat`) keep reporting the same
 * `started_at` across the whole time it stays up — a fresh `started_at` on every tick would make
 * a long-lived process look like it keeps restarting.
 */
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
  /** Called when a tick's UPSERT fails; a transient DB error must not throw out of the interval and crash the process. */
  onError?: (err: unknown) => void;
}

export interface ProcessHeartbeatHandle {
  stop(): void;
}

/**
 * Starts a process's own 15-second UPSERT loop against its identity row (issue #168's Task:
 * "Each process UPSERTs every 15 seconds from its event loop"). Ticks immediately so the row
 * exists as soon as the process is up, then on `intervalMs`. The returned handle's `stop()`
 * only clears the timer — it deliberately never deletes the row, so the last-known `beat_at`
 * simply goes stale rather than the process disappearing from the expected set entirely.
 */
export function startProcessHeartbeat(
  pool: Pool,
  identity: ProcessHeartbeatIdentity,
  options: ProcessHeartbeatOptions = {},
): ProcessHeartbeatHandle {
  const intervalMs = options.intervalMs ?? PROCESS_HEARTBEAT_INTERVAL_MS;
  const startedAt = new Date();

  function tick(): void {
    upsertProcessHeartbeat(pool, identity, startedAt).catch((err: unknown) => {
      options.onError?.(err);
    });
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

/** One row per currently-connected mailbox (`mail_account_sync_state`, issue #26/#195) — the "active mailboxes" this issue's Task derives expected `mailsync:<id>` rows from. */
export async function getActiveMailSyncProcessNames(client: Queryable): Promise<string[]> {
  const result = await client.query<{ item_id: string }>("SELECT item_id FROM mail_account_sync_state");
  return result.rows.map((row) => mailSyncProcessName(row.item_id));
}

/** The four fixed processes plus one `mailsync:<id>` per currently-active mailbox. */
export async function getExpectedProcessNames(client: Queryable): Promise<string[]> {
  const mailSyncNames = await getActiveMailSyncProcessNames(client);
  return [...FIXED_PROCESS_NAMES, ...mailSyncNames];
}

export interface ProcessHeartbeatStatus {
  process: string;
  /** false when no row exists yet for a process the current state expects to be beating. */
  present: boolean;
  /** true when `present` is false, or the row's `beat_at` is older than the stale threshold. */
  stale: boolean;
  beatAt: string | null;
}

/**
 * One status per currently-expected process (`getExpectedProcessNames`), joined against whatever
 * rows actually exist. A mailbox that was deactivated since its last beat is simply absent from
 * this list — its old row, if any, is never reported as missing or stale because it is no longer
 * expected.
 */
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

/** `GET /healthz`'s freshness check for whichever process name it's given: a fresh row means one exists and beat within the stale threshold. */
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
