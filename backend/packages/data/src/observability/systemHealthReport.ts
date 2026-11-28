import { assertKnownValue } from "../dbRowValidation.js";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
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
  /** false when an expected process has no heartbeat row yet. */
  present: boolean;
  /** true when absent or older than the stale threshold. */
  stale: boolean;
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  beatAt: string | null;
  /** null when the process has never beaten. */
  uptimeMs: number | null;
}

export interface AlertingCheck {
  checkKey: string;
  detail: Record<string, unknown>;
  changedAt: string;
}

export interface QueueHealthCounts {
  pending: number;
  /** Past `run_at` by more than a short grace window. */
  overdue: number;
  /** `attempts >= max_attempts`: will never run again on its own. */
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

/** The caller decides the set; the operator report passes the fixed list so mailbox rows never appear. */
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

/** Tenant checks only; the global table is operator data. */
async function getAlertingChecks(client: Queryable): Promise<AlertingCheck[]> {
  const { rows } = await client.query<{ check_key: string; detail: Record<string, unknown>; changed_at: Date }>(
    `SELECT check_key, detail, changed_at FROM tenant_observability_checks
     WHERE status = 'alerting' AND tenant_id = app_current_tenant()
     ORDER BY changed_at`,
  );
  return rows.map((row) => ({ checkKey: row.check_key, detail: row.detail, changedAt: row.changed_at.toISOString() }));
}

/**
 * Same predicates as the queue checks, as plain counts. The grace window matters because a fresh
 * job's `run_at` is its insertion time, so a bare `run_at < now()` would flag nearly every job.
 *
 * `tenantOnly` filters on the envelope's `tenantId`, which only `_private_jobs` exposes; this relies
 * on graphile-worker@0.17.x internals like `queueFailedJobsPrune.ts`. The two switched SQL literals
 * take no caller input. Jobs without a `tenantId` appear only in operator counts.
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

/** Grouped by the item's database; only automation rows of live items count. */
async function getItemAutomationErrorCounts(client: Queryable): Promise<ItemAutomationErrorCount[]> {
  const { rows } = await client.query<{ database_id: string; error_count: string }>(
    `SELECT i.database_id, count(*) AS error_count
     FROM item_automation ia
     JOIN items i ON i.id = ia.item_id AND i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL
     WHERE ia.status = 'error' AND ia.tenant_id = app_current_tenant()
     GROUP BY i.database_id
     ORDER BY i.database_id`,
    [await visibleDatabaseIds(client)],
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

/** A missing tenant scope is a wiring bug: throw rather than return an empty, healthy-looking report. */
async function assertTenantScope(client: Queryable): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string | null }>(`SELECT app_current_tenant()::text AS tenant_id`);
  if (!rows[0]?.tenant_id) {
    throw new Error("getSystemHealthReport requires an active tenant scope");
  }
}

/** The caller's own tenant only, computed fresh; operator-wide data is `getOperatorHealthReport`. */
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

/** Totals only; never a tenant id or per-tenant breakdown. */
export interface OperatorTenantAggregates {
  agentRunErrors7d: number;
  itemAutomationErrors: number;
  alertingTenantChecks: number;
}

/** Admin-only; content-free counts and global rows, never tenant content. */
export interface OperatorHealthReport {
  generatedAt: string;
  processes: ProcessHealthStatus[];
  alertingChecks: AlertingCheck[];
  queue: QueueHealthCounts;
  tenants: TenantStatusCounts;
  tenantAggregates: OperatorTenantAggregates;
}

async function getGlobalAlertingChecks(client: Queryable): Promise<AlertingCheck[]> {
  const { rows } = await client.query<{ check_key: string; detail: Record<string, unknown>; changed_at: Date }>(
    `SELECT check_key, detail, changed_at FROM observability_checks
     WHERE status = 'alerting'
     ORDER BY changed_at`,
  );
  return rows.map((row) => ({ checkKey: row.check_key, detail: row.detail, changedAt: row.changed_at.toISOString() }));
}

/** A status with no tenant reports 0. */
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
 * Runs as `alldots_router` behind `ops_health_counts()`. A missing row means broken grants and
 * throws rather than reporting zero errors.
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

/** Fixed processes and counts only, so no tenant id, item text or `lastError` reaches the response. */
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
