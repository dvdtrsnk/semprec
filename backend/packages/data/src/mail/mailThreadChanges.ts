import type { PoolClient } from "pg";
import { z } from "zod";
import { requireSingleRow, runAfterCommit, runBeforeCommitOnce, TransactionLocal } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { notifyInvalidation } from "../realtimeHook.js";

/** At most this many changed threads are answered as a delta; more is a `reset`. */
export const MAIL_THREAD_CHANGES_LIMIT = 500;

interface TouchedMailThreads {
  threadIds: Set<string>;
  /** A change no single thread list names (`touchAllMailThreads`). */
  all: boolean;
}

const touched = new TransactionLocal<TouchedMailThreads>(() => ({ threadIds: new Set(), all: false }));
const FLUSH_KEY = Symbol("mailThreadChanges");

function touchedIn(client: PoolClient): TouchedMailThreads {
  const state = touched.get(client);
  if (state === undefined)
    throw new Error("A mail thread change requires the active managed transaction of its client");
  runBeforeCommitOnce(client, FLUSH_KEY, (flushing) => flushMailThreadChanges(flushing, state));
  return state;
}

/**
 * Records that the list rows of these threads (live, merged away or deleted) change in this transaction. Right
 * before `COMMIT` the transaction takes the tenant's next change step and stamps every recorded thread with it,
 * then, after the commit, sends one tenant-wide `mailThread` invalidation per thread. No thread records nothing. A
 * thread recorded inside a savepoint that rolls back stays recorded: a stamp without a change only makes a client
 * read the row again.
 */
export function touchMailThreads(client: PoolClient, threadIds: readonly string[]): void {
  if (threadIds.length === 0) return;
  const state = touchedIn(client);
  for (const threadId of threadIds) state.threadIds.add(threadId);
}

/**
 * Records a change of every thread list row at once (a mailbox's name or addresses, a folder's purpose): every delta
 * cursor taken before this transaction's step is answered with `reset`. Sends no invalidation; the item write that
 * caused it sends its own.
 */
export function touchAllMailThreads(client: PoolClient): void {
  touchedIn(client).all = true;
}

const stepRow = z.object({ seq: z.string().regex(/^[0-9]+$/) });

/**
 * The counter row's lock is the last lock the transaction takes and is held until `COMMIT`, so the tenant's
 * committed steps are numbered in commit order: a transaction that reads step `n` sees every step up to `n`.
 */
async function flushMailThreadChanges(client: PoolClient, state: TouchedMailThreads): Promise<void> {
  if (state.threadIds.size === 0 && !state.all) return;
  const step = stepRow.parse(
    requireSingleRow(
      (
        await client.query<{ seq: unknown }>(
          `INSERT INTO mail_thread_change_counters (seq, reset_seq) VALUES (1, CASE WHEN $1::boolean THEN 1 ELSE 0 END)
           ON CONFLICT (tenant_id) DO UPDATE SET seq = mail_thread_change_counters.seq + 1,
             reset_seq = CASE WHEN $1::boolean THEN mail_thread_change_counters.seq + 1
               ELSE mail_thread_change_counters.reset_seq END
           RETURNING seq::text AS seq`,
          [state.all],
        )
      ).rows,
      "mail thread change step",
    ),
  ).seq;
  const threadIds = [...state.threadIds].sort();
  if (threadIds.length === 0) return;
  const stamped = await client.query(
    `INSERT INTO mail_thread_changes (thread_id, seq) SELECT unnest($1::uuid[]), $2::bigint
     ON CONFLICT (tenant_id, thread_id) DO UPDATE SET seq = EXCLUDED.seq`,
    [threadIds, step],
  );
  if (stamped.rowCount !== threadIds.length) throw new Error("A mail thread change was not stamped");
  for (const threadId of threadIds) runAfterCommit(client, () => notifyInvalidation({ scope: "mailThread", threadId }));
}

/** Where the tenant's mail list stands: `epoch` is `null` while no change was ever recorded. */
export interface MailThreadChangePoint {
  epoch: string | null;
  seq: number;
  resetSeq: number;
}

const pointRow = z.object({
  epoch: z.uuid(),
  seq: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number),
  reset_seq: z
    .string()
    .regex(/^[0-9]+$/)
    .transform(Number),
});

/** Read in the same snapshot as the rows it describes (a `repeatable_read` transaction). */
export async function readMailThreadChangePoint(client: PoolClient): Promise<MailThreadChangePoint> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT epoch, seq::text AS seq, reset_seq::text AS reset_seq FROM mail_thread_change_counters
     WHERE tenant_id = app_tenant_default()`,
  );
  if (rows[0] === undefined) return { epoch: null, seq: 0, resetSeq: 0 };
  const row = pointRow.parse(rows[0]);
  return { epoch: row.epoch, seq: row.seq, resetSeq: row.reset_seq };
}

const cursorSchema = z
  .object({ e: z.uuid().nullable(), s: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();

export interface MailThreadChangesCursor {
  epoch: string | null;
  seq: number;
}

export function encodeMailThreadChangesCursor(point: MailThreadChangePoint): string {
  return Buffer.from(JSON.stringify({ e: point.epoch, s: point.seq })).toString("base64url");
}

/** Decodes a cursor `encodeMailThreadChangesCursor` wrote; throws a `ValidationError` naming `since` otherwise. */
export function parseMailThreadChangesCursor(raw: string): MailThreadChangesCursor {
  if (raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new ValidationError("Invalid since", { field: "since" });
  let decoded: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error("Invalid encoding");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError("Invalid since", { field: "since" });
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw new ValidationError("Invalid since", { field: "since" });
  return { epoch: parsed.data.e, seq: parsed.data.s };
}

/**
 * `true` when the cursor cannot be read against `point`: another counter (a recreated database), a step this
 * tenant never reached, or a step before the last change of every row. A cursor without an epoch was taken before
 * the tenant's first change, so every step since then is listed.
 */
export function mailThreadChangesCursorIsStale(cursor: MailThreadChangesCursor, point: MailThreadChangePoint): boolean {
  if (cursor.epoch !== null && cursor.epoch !== point.epoch) return true;
  return cursor.seq > point.seq || cursor.seq < point.resetSeq;
}

/** The threads stamped after `seq`, oldest step first; `null` when more than `limit` were. */
export async function listMailThreadsChangedSince(
  client: PoolClient,
  seq: number,
  limit: number,
): Promise<string[] | null> {
  const { rows } = await client.query<{ thread_id: string }>(
    `SELECT thread_id FROM mail_thread_changes WHERE tenant_id = app_tenant_default() AND seq > $1::bigint
     ORDER BY seq, thread_id LIMIT $2`,
    [seq, limit + 1],
  );
  if (rows.length > limit) return null;
  return rows.map((row) => z.uuid().parse(row.thread_id));
}
