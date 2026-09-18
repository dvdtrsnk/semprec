import type { Queryable } from "../db/pool.js";
import { getExpectedProcessNames, PROCESS_HEARTBEAT_STALE_AFTER_MS } from "../health/processHeartbeats.js";
import { listAllMailAccountSyncStates } from "../mail/mailAccountSyncStateStore.js";

export interface ProcessHealthStatus {
  process: string;
  /** false when no `process_heartbeats` row exists yet for a process the current state expects. */
  present: boolean;
  /** true when `present` is false, or the row's `beatAt` is older than the stale threshold. */
  stale: boolean;
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  beatAt: string | null;
  /** `now - startedAt`, null when the process has never beaten at all. */
  uptimeMs: number | null;
}

export interface AlertingCheck {
  checkKey: string;
  detail: Record<string, unknown>;
  changedAt: string;
}

export interface QueueHealthCounts {
  pending: number;
  /** Pending jobs whose `run_at` has already passed by more than a short grace window. */
  overdue: number;
  /** graphile-worker's own `attempts >= max_attempts` — will never run again on its own. */
  permanent: number;
}

export interface ItemAutomationErrorCount {
  databaseId: string;
  errorCount: number;
}

export interface MailboxHealthStatus {
  mailboxItemId: string;
  lastActivityAt: string | null;
  lastError: string | null;
  nextExpectedActivityAt: string | null;
}

export interface SystemHealthReport {
  generatedAt: string;
  processes: ProcessHealthStatus[];
  alertingChecks: AlertingCheck[];
  queue: QueueHealthCounts;
  itemAutomationErrorsByDatabase: ItemAutomationErrorCount[];
  agentRunErrors7d: number;
  mailboxes: MailboxHealthStatus[];
}

/** One row per currently-expected process (`getExpectedProcessNames`, issue #168), joined against whatever `process_heartbeats` rows actually exist. */
async function getProcessHealthStatuses(client: Queryable): Promise<ProcessHealthStatus[]> {
  const expected = await getExpectedProcessNames(client);
  if (expected.length === 0) return [];

  const { rows } = await client.query<{
    process: string;
    pid: number;
    version: string;
    started_at: Date;
    beat_at: Date;
  }>(`SELECT process, pid, version, started_at, beat_at FROM process_heartbeats WHERE process = ANY($1)`, [expected]);
  const byProcess = new Map(rows.map((row) => [row.process, row]));
  const now = Date.now();

  return expected.map((process) => {
    const row = byProcess.get(process);
    if (!row) {
      return {
        process,
        present: false,
        stale: true,
        pid: null,
        version: null,
        startedAt: null,
        beatAt: null,
        uptimeMs: null,
      };
    }
    return {
      process,
      present: true,
      stale: now - row.beat_at.getTime() > PROCESS_HEARTBEAT_STALE_AFTER_MS,
      pid: row.pid,
      version: row.version,
      startedAt: row.started_at.toISOString(),
      beatAt: row.beat_at.toISOString(),
      uptimeMs: now - row.started_at.getTime(),
    };
  });
}

/** Every currently-`alerting` row of issue #169's `observability_checks` — the one signal this report treats as authoritative for "is a component degraded." */
async function getAlertingChecks(client: Queryable): Promise<AlertingCheck[]> {
  const { rows } = await client.query<{ check_key: string; detail: Record<string, unknown>; changed_at: Date }>(
    `SELECT check_key, detail, changed_at FROM observability_checks WHERE status = 'alerting' ORDER BY changed_at`,
  );
  return rows.map((row) => ({ checkKey: row.check_key, detail: row.detail, changedAt: row.changed_at.toISOString() }));
}

/**
 * Same `graphile_worker.jobs` predicates as `observability/observabilityCheckSystem.ts`'s queue
 * checks, reported as plain current counts rather than a hysteresis-gated status. A
 * freshly-enqueued job's `run_at` defaults to its insertion time, so a bare `run_at < now()`
 * would call it overdue the instant any time at all has passed — true of nearly every ready job.
 * "Overdue" means stuck past its due time long enough that the worker fleet should have already
 * picked it up, not merely past due; this grace window separates the two.
 */
async function getQueueHealthCounts(client: Queryable): Promise<QueueHealthCounts> {
  const { rows } = await client.query<{ pending: string; overdue: string; permanent: string }>(
    `SELECT
       count(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts) AS pending,
       count(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts AND run_at < now() - interval '1 minute') AS overdue,
       count(*) FILTER (WHERE attempts >= max_attempts) AS permanent
     FROM graphile_worker.jobs`,
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    overdue: Number(row?.overdue ?? 0),
    permanent: Number(row?.permanent ?? 0),
  };
}

/**
 * `item_automation.item_id` has no FK to `items` (partitioned table, application-enforced
 * referential integrity — same deviation `0005_library_module.sql`'s own comment documents), so
 * grouping by database goes through a plain join rather than a stored `database_id` column.
 */
async function getItemAutomationErrorCounts(client: Queryable): Promise<ItemAutomationErrorCount[]> {
  const { rows } = await client.query<{ database_id: string; error_count: string }>(
    `SELECT i.database_id, count(*) AS error_count
     FROM item_automation ia
     JOIN items i ON i.id = ia.item_id
     WHERE ia.status = 'error'
     GROUP BY i.database_id
     ORDER BY i.database_id`,
  );
  return rows.map((row) => ({ databaseId: row.database_id, errorCount: Number(row.error_count) }));
}

async function getAgentRunErrorCount7d(client: Queryable): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM agent_runs WHERE status = 'error' AND started_at >= now() - interval '7 days'`,
  );
  return Number(rows[0]?.count ?? 0);
}

function toMailboxHealthStatus(
  account: Awaited<ReturnType<typeof listAllMailAccountSyncStates>>[number],
): MailboxHealthStatus {
  return {
    mailboxItemId: account.itemId,
    lastActivityAt: account.lastActivityAt,
    lastError: account.lastError,
    nextExpectedActivityAt: account.nextExpectedActivityAt,
  };
}

/**
 * The read model behind issue #170's `GET /api/system-health`: a live snapshot of process
 * freshness/version/uptime, every currently-alerting `observability_checks` row (issue #169),
 * graphile-worker queue counts, `item_automation` errors per database, agent-run errors over the
 * last seven days, and per-mailbox sync activity/error — no samples persisted, computed fresh on
 * every request.
 */
export async function getSystemHealthReport(client: Queryable): Promise<SystemHealthReport> {
  const [processes, alertingChecks, queue, itemAutomationErrorsByDatabase, agentRunErrors7d, mailAccounts] =
    await Promise.all([
      getProcessHealthStatuses(client),
      getAlertingChecks(client),
      getQueueHealthCounts(client),
      getItemAutomationErrorCounts(client),
      getAgentRunErrorCount7d(client),
      listAllMailAccountSyncStates(client),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    processes,
    alertingChecks,
    queue,
    itemAutomationErrorsByDatabase,
    agentRunErrors7d,
    mailboxes: mailAccounts.map(toMailboxHealthStatus),
  };
}
