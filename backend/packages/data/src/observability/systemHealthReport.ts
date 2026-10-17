import { assertKnownValue } from "../dbRowValidation.js";
import type { Queryable } from "../db/pool.js";
import { TENANT_STATUSES } from "../tenancy/tenantsStore.js";
import {
  FIXED_PROCESS_NAMES,
  getActiveMailSyncProcessNames,
  PROCESS_HEARTBEAT_STALE_AFTER_MS,
} from "../health/processHeartbeats.js";
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

/**
 * One row per process in `expected`, joined against whatever `process_heartbeats` rows actually
 * exist. The caller decides the set: the per-tenant report passes the caller's mailbox processes
 * (`getActiveMailSyncProcessNames`, issue #1052), the operator report passes the fixed list so
 * mailbox rows never appear.
 */
async function getProcessHealthStatuses(
  client: Queryable,
  expected: readonly string[],
): Promise<ProcessHealthStatus[]> {
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

/**
 * The caller's alerting `tenant_observability_checks` rows (issue #169's per-tenant checks). The
 * global `observability_checks` table is operator data and is left to the operator report.
 */
async function getAlertingChecks(client: Queryable): Promise<AlertingCheck[]> {
  const { rows } = await client.query<{ check_key: string; detail: Record<string, unknown>; changed_at: Date }>(
    `SELECT check_key, detail, changed_at FROM tenant_observability_checks
     WHERE status = 'alerting' AND tenant_id = app_current_tenant()
     ORDER BY changed_at`,
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
 *
 * `tenantOnly` narrows the count to jobs whose queue envelope names the caller's tenant
 * (`payload->>'tenantId'`, stamped by `enqueueJob`). The public `graphile_worker.jobs` view has no
 * `payload` column, so that branch reads `graphile_worker._private_jobs`, the table the queue
 * package's test helper `readJobPayloadsByIdentifier` also reads. The two literals below are the
 * only SQL `tenantOnly` switches in; neither takes caller input.
 */
async function getQueueHealthCounts(client: Queryable, tenantOnly: boolean): Promise<QueueHealthCounts> {
  const jobSource = tenantOnly
    ? "graphile_worker._private_jobs WHERE payload->>'tenantId' = app_current_tenant()::text"
    : "graphile_worker.jobs";
  const { rows } = await client.query<{ pending: string; overdue: string; permanent: string }>(
    `SELECT
       count(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts) AS pending,
       count(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts AND run_at < now() - interval '1 minute') AS overdue,
       count(*) FILTER (WHERE locked_at IS NULL AND attempts >= max_attempts) AS permanent
     FROM ${jobSource}`,
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
     WHERE ia.status = 'error' AND ia.tenant_id = app_current_tenant()
     GROUP BY i.database_id
     ORDER BY i.database_id`,
  );
  return rows.map((row) => ({ databaseId: row.database_id, errorCount: Number(row.error_count) }));
}

async function getAgentRunErrorCount7d(client: Queryable): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM agent_runs
     WHERE status = 'error' AND started_at >= now() - interval '7 days' AND tenant_id = app_current_tenant()`,
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
 * Asserts that the caller runs inside a tenant scope. Every section below reads through the
 * caller's `app.tenant_id`, so a missing scope is a wiring bug. It throws rather than returning a
 * report that looks empty and healthy.
 */
async function assertTenantScope(client: Queryable): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string | null }>(`SELECT app_current_tenant()::text AS tenant_id`);
  if (!rows[0]?.tenant_id) {
    throw new Error("getSystemHealthReport requires an active tenant scope");
  }
}

/**
 * The per-tenant read model behind issue #170's `GET /api/system-health`, a snapshot of the
 * caller's own tenant (issue #1052). It holds the freshness of the caller's mailbox processes,
 * the caller's alerting tenant checks, the caller's queue jobs, the caller's `item_automation`
 * errors per database, its agent-run errors over the last seven days, and per-mailbox sync
 * activity/error. Operator-wide data is out of scope here; `getOperatorHealthReport` serves it.
 * No samples are persisted, and the report is computed fresh on every request.
 */
export async function getSystemHealthReport(client: Queryable): Promise<SystemHealthReport> {
  await assertTenantScope(client);
  const [processes, alertingChecks, queue, itemAutomationErrorsByDatabase, agentRunErrors7d, mailAccounts] =
    await Promise.all([
      getActiveMailSyncProcessNames(client).then((names) => getProcessHealthStatuses(client, names)),
      getAlertingChecks(client),
      getQueueHealthCounts(client, true),
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

export interface TenantStatusCounts {
  provisioning: number;
  active: number;
  suspended: number;
  deleting: number;
}

/** Totals only, one per `ops_health_counts()` column. Never a tenant id, never a per-tenant breakdown. */
export interface OperatorTenantAggregates {
  agentRunErrors7d: number;
  itemAutomationErrors: number;
  alertingTenantChecks: number;
}

/** The admin-only operator report (issue #1038): content-free counts and global operator rows, never tenant content. */
export interface OperatorHealthReport {
  generatedAt: string;
  processes: ProcessHealthStatus[];
  alertingChecks: AlertingCheck[];
  queue: QueueHealthCounts;
  tenants: TenantStatusCounts;
  tenantAggregates: OperatorTenantAggregates;
}

/**
 * Global `observability_checks` rows only. The operator report never reads
 * `tenant_observability_checks`, the per-tenant table `getAlertingChecks` reads. Legacy per-mailbox `mail:<itemId>`
 * and `process:mailsync:<itemId>` rows, whose key carries a mailbox id and whose `detail` carries
 * its `lastError`, are excluded here: `handleObservabilityCheckSystemTask` purges them only on its
 * next tick, so they can still exist when this report is read.
 */
async function getGlobalAlertingChecks(client: Queryable): Promise<AlertingCheck[]> {
  const { rows } = await client.query<{ check_key: string; detail: Record<string, unknown>; changed_at: Date }>(
    `SELECT check_key, detail, changed_at FROM observability_checks
     WHERE status = 'alerting' AND check_key NOT LIKE 'mail:%' AND check_key NOT LIKE 'process:mailsync:%'
     ORDER BY changed_at`,
  );
  return rows.map((row) => ({ checkKey: row.check_key, detail: row.detail, changedAt: row.changed_at.toISOString() }));
}

/** `count(*) GROUP BY tenants.status`; a status with no tenant reports 0. */
async function getTenantStatusCounts(client: Queryable): Promise<TenantStatusCounts> {
  const { rows } = await client.query<{ status: string; count: string }>(
    `SELECT status, count(*) AS count FROM tenants GROUP BY status`,
  );
  const counts: TenantStatusCounts = { provisioning: 0, active: 0, suspended: 0, deleting: 0 };
  for (const row of rows) {
    const status = assertKnownValue(TENANT_STATUSES, row.status, "tenants.status");
    counts[status] = Number(row.count);
  }
  return counts;
}

/**
 * The three cross-tenant counts, run as `semprec_router` behind `ops_health_counts()`
 * (migration 0075, docs/operations/database-roles.md). The function always returns one row of
 * numbers, so a missing row means the function or its grants are broken and is thrown rather than
 * reported as zero errors.
 */
async function getOperatorTenantAggregates(client: Queryable): Promise<OperatorTenantAggregates> {
  const { rows } = await client.query<{
    agent_run_errors_7d: string;
    item_automation_errors: string;
    alerting_tenant_checks: string;
  }>(`SELECT agent_run_errors_7d, item_automation_errors, alerting_tenant_checks FROM ops_health_counts()`);
  const row = rows[0];
  if (!row) {
    throw new Error("ops_health_counts() returned no row");
  }
  return {
    agentRunErrors7d: Number(row.agent_run_errors_7d),
    itemAutomationErrors: Number(row.item_automation_errors),
    alertingTenantChecks: Number(row.alerting_tenant_checks),
  };
}

/**
 * The admin operations health report behind `GET /api/admin/health` (issue #1038). Processes are
 * the four fixed processes only, so no mailbox heartbeat row is reported. Every value is a count
 * or a global operator row (legacy per-mailbox rows excluded), so no tenant id, item text or
 * `lastError` reaches the response.
 */
export async function getOperatorHealthReport(client: Queryable): Promise<OperatorHealthReport> {
  const [processes, alertingChecks, queue, tenants, tenantAggregates] = await Promise.all([
    getProcessHealthStatuses(client, FIXED_PROCESS_NAMES),
    getGlobalAlertingChecks(client),
    getQueueHealthCounts(client, false),
    getTenantStatusCounts(client),
    getOperatorTenantAggregates(client),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    processes,
    alertingChecks,
    queue,
    tenants,
    tenantAggregates,
  };
}
