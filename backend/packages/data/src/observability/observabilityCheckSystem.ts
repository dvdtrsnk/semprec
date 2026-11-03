import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import {
  FIXED_PROCESS_NAMES,
  getExpectedProcessHeartbeatStatuses,
  type ProcessHeartbeatStatus,
} from "../health/processHeartbeats.js";
import {
  listAllMailAccountSyncStates,
  lockMailAccountSyncState,
  type MailAccountSyncStateRow,
} from "../mail/mailAccountSyncStateStore.js";
import {
  transitionObservabilityCheck,
  transitionTenantObservabilityCheck,
  deleteOrphanedObservabilityChecks,
  deleteOrphanedTenantObservabilityChecks,
  type ObservabilityCheckStatus,
} from "./observabilityChecksStore.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { AGENTS_PROCESS_PROBLEM_KEY, mailProblemKey } from "../semp/sourceProblemKeys.js";
import { writeOperatorAlert } from "./operatorAlerts.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { FAILED_JOB_RETENTION_MS } from "./queueFailedJobsPrune.js";

export interface ObservabilityCheckSystemHelpers {
  /** The firing crontab job's own id — the stable base a retry of this same tick reuses, so a redelivery after a mid-transaction crash lands on the same `transitionInstance` as the attempt it's retrying, instead of a fresh one that would slip past `writeNotification`'s dedupe. */
  job: { id: string };
}

/** Notifies the current tenant's user of a mailbox stall; skips when the tenant has no bound user. Must run inside the tenant's transaction. */
async function notifyMailSyncStalled(
  client: PoolClient,
  helpers: ObservabilityCheckSystemHelpers,
  checkKey: string,
  checkId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const userId = await getTenantUserId(client);
  if (!userId) return;
  await writeNotification(client, {
    userId,
    kind: "mail_sync_stalled",
    linkHref: null,
    sourceTable: "tenant_observability_checks",
    sourceId: checkId,
    transitionInstance: `${helpers.job.id}:${checkKey}`,
    payload: detail,
  });
}

/**
 * Raises the mailbox's Semp problem when its stall check alerts (issue #1506), under the same
 * `mail:<mailboxItemId>` key the sync job raises, so the two reports merge. Severity follows the
 * stored failure kind: a revoked credential is critical, a stall without a failure a warning. Skipped
 * when the tenant has no bound user, like the notification. Must run inside the tenant's transaction.
 */
async function raiseMailSyncProblem(
  client: PoolClient,
  helpers: ObservabilityCheckSystemHelpers,
  checkKey: string,
  account: MailAccountSyncStateRow,
): Promise<void> {
  const userId = await getTenantUserId(client);
  if (!userId) return;
  await raiseProblem(client, {
    userId,
    category: "mail",
    kind: "mailSyncError",
    severity: account.lastFailureKind === "reauthorization" ? "critical" : "warning",
    sourceTable: "mail_account_sync_state",
    sourceId: account.itemId,
    dedupeKey: mailProblemKey(account.itemId),
    since: account.failingSince ? new Date(account.failingSince) : new Date(),
    occurrenceKey: `${helpers.job.id}:${checkKey}`,
  });
}

const FIXED_PROCESS_NAME_SET: ReadonlySet<string> = new Set(FIXED_PROCESS_NAMES);

function isFixedProcessStatus(processStatus: ProcessHeartbeatStatus): boolean {
  return FIXED_PROCESS_NAME_SET.has(processStatus.process);
}

/**
 * One global `process:<name>` check per fixed process (`FIXED_PROCESS_NAMES`) — stale beyond
 * `process_heartbeats.ts`'s own 60s threshold is the fault, no further hysteresis needed on top of
 * that. Process liveness is global only for these four; each mailbox's `mailsync:<id>` liveness is a
 * per-tenant check (`checkMailSyncLiveness`), so no mailbox id reaches the global plane.
 */
async function checkProcessHeartbeats(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const statuses = await withTransaction(pool, (client) => getExpectedProcessHeartbeatStatuses(client));
  for (const processStatus of statuses.filter(isFixedProcessStatus)) {
    const checkKey = `process:${processStatus.process}`;
    await withTransaction(pool, async (client) => {
      const transition = await transitionObservabilityCheck(client, checkKey, () => ({
        status: processStatus.stale ? "alerting" : "ok",
        detail: { process: processStatus.process, present: processStatus.present, beatAt: processStatus.beatAt },
      }));
      if (transition.transitionedToAlerting) {
        await writeOperatorAlert(pool, client, {
          kind: "process_stale",
          checkId: transition.id,
          transitionInstance: `${helpers.job.id}:${checkKey}`,
          payload: { process: processStatus.process, beatAt: processStatus.beatAt },
          // Only the agents process raises a problem; the other fixed processes keep the notification alone.
          problem:
            processStatus.process === "agents"
              ? {
                  category: "agents",
                  kind: "processStale",
                  severity: "critical",
                  dedupeKey: AGENTS_PROCESS_PROBLEM_KEY,
                  occurrenceKey: `${helpers.job.id}:${checkKey}`,
                }
              : undefined,
        });
      }
    });
  }
}

const MAIL_SYNC_PROCESS_CHECK_PREFIX = "process:mailsync:";
const MAIL_SYNC_PROCESS_PREFIX = "mailsync:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One `process:mailsync:<id>` check per active mailbox of the *current tenant*: under RLS
 * `getExpectedProcessHeartbeatStatuses` yields exactly this tenant's `mailsync:<id>` processes
 * beside the fixed ones (filtered out here); the heartbeat rows are read by name from the global
 * `process_heartbeats` table. Must run inside a tenant scope (`forEachActiveTenant`). Rows of
 * mailboxes that are no longer active are removed first, so none can sit `alerting` forever.
 */
async function checkMailSyncLiveness(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const statuses = (await withTransaction(pool, (client) => getExpectedProcessHeartbeatStatuses(client))).filter(
    (processStatus) => !isFixedProcessStatus(processStatus),
  );
  await withTransaction(pool, (client) =>
    deleteOrphanedTenantObservabilityChecks(
      client,
      MAIL_SYNC_PROCESS_CHECK_PREFIX,
      statuses.map((processStatus) => `process:${processStatus.process}`),
    ),
  );
  for (const processStatus of statuses) {
    const checkKey = `process:${processStatus.process}`;
    const mailboxItemId = processStatus.process.slice(MAIL_SYNC_PROCESS_PREFIX.length);
    if (!processStatus.process.startsWith(MAIL_SYNC_PROCESS_PREFIX) || !UUID_RE.test(mailboxItemId)) {
      throw new Error(`Unexpected non-mailbox process in the tenant liveness pass: ${processStatus.process}`);
    }
    await withTransaction(pool, async (client) => {
      const transition = await transitionTenantObservabilityCheck(client, checkKey, () => ({
        status: processStatus.stale ? "alerting" : "ok",
        detail: { process: processStatus.process, present: processStatus.present, beatAt: processStatus.beatAt },
      }));
      if (transition.transitionedToAlerting) {
        await notifyMailSyncStalled(client, helpers, checkKey, transition.id, {
          mailboxItemId,
          beatAt: processStatus.beatAt,
        });
      }
    });
  }
}

interface QueueBacklogSnapshot {
  pending: number;
  /** `now() - oldest pending job's run_at`, or `null` when nothing is pending. */
  oldestAgeMs: number | null;
}

/** Excludes permanently-failed jobs (`attempts >= max_attempts`, checked separately below) — a dead job sitting in the table forever must not itself look like a growing backlog. */
async function getQueueBacklogSnapshot(client: PoolClient): Promise<QueueBacklogSnapshot> {
  const { rows } = await client.query<{ pending: string; oldest_run_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts) AS pending,
            min(run_at) FILTER (WHERE locked_at IS NULL AND attempts < max_attempts) AS oldest_run_at
     FROM graphile_worker.jobs`,
  );
  const row = rows[0];
  const pending = row ? Number(row.pending) : 0;
  const oldestAgeMs = row?.oldest_run_at ? Date.now() - row.oldest_run_at.getTime() : null;
  return { pending, oldestAgeMs };
}

const QUEUE_BACKLOG_PENDING_ALERT = 100;
const QUEUE_BACKLOG_PENDING_RECOVER = QUEUE_BACKLOG_PENDING_ALERT / 2;
const QUEUE_BACKLOG_OLDEST_ALERT_MS = 10 * 60_000;
const QUEUE_BACKLOG_OLDEST_RECOVER_MS = QUEUE_BACKLOG_OLDEST_ALERT_MS / 2;

/**
 * Hysteresis (issue #169's "recovering below half"): entering `alerting` takes either metric past
 * its full threshold, but leaving it back to `ok` requires *both* metrics under half that
 * threshold — a snapshot sitting between the two bands (e.g. pending oscillating around 90-110)
 * stays in whichever state it was already in instead of flapping a notification every minute.
 */
function computeQueueBacklogStatus(
  previousStatus: ObservabilityCheckStatus | null,
  snapshot: QueueBacklogSnapshot,
): ObservabilityCheckStatus {
  const breached =
    snapshot.pending > QUEUE_BACKLOG_PENDING_ALERT ||
    (snapshot.oldestAgeMs !== null && snapshot.oldestAgeMs > QUEUE_BACKLOG_OLDEST_ALERT_MS);
  const recovered =
    snapshot.pending <= QUEUE_BACKLOG_PENDING_RECOVER &&
    (snapshot.oldestAgeMs === null || snapshot.oldestAgeMs <= QUEUE_BACKLOG_OLDEST_RECOVER_MS);

  if (previousStatus === "alerting") return recovered ? "ok" : "alerting";
  return breached ? "alerting" : "ok";
}

async function checkQueueBacklog(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const checkKey = "queue:backlog";
  await withTransaction(pool, async (client) => {
    const snapshot = await getQueueBacklogSnapshot(client);
    const transition = await transitionObservabilityCheck(client, checkKey, (previousStatus) => ({
      status: computeQueueBacklogStatus(previousStatus, snapshot),
      detail: { pending: snapshot.pending, oldestAgeMs: snapshot.oldestAgeMs },
    }));
    if (transition.transitionedToAlerting) {
      await writeOperatorAlert(pool, client, {
        kind: "queue_backlog",
        checkId: transition.id,
        transitionInstance: `${helpers.job.id}:${checkKey}`,
        payload: { pending: snapshot.pending, oldestAgeMs: snapshot.oldestAgeMs },
      });
    }
  });
}

/**
 * graphile-worker's own "permanently failed" state (`attempts >= max_attempts`, the same condition
 * its `permanently_fail_jobs` SQL function sets) — a job in this state will never run again on its
 * own and needs a human, unlike an ordinary in-flight retry.
 *
 * Excludes locked rows: `add_jobs` bumps `attempts` to `max_attempts` on a *running* job the
 * moment its key is re-added (e.g. a long mail sync re-enqueued mid-run), so a locked row in this
 * state is still in flight and about to succeed, not actually dead.
 *
 * Excludes rows older than `FAILED_JOB_RETENTION_MS`: `queueFailedJobsPrune` deletes those daily,
 * and each was already alerted on while it was young (`fresh unlocked row` below). Once no new
 * row appears, every existing one eventually ages out of this window and the check recovers on
 * its own without anything having to acknowledge or clear it.
 */
async function checkPermanentlyFailedJobs(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const checkKey = "queue:permanentlyFailedJobs";
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM graphile_worker.jobs
       WHERE attempts >= max_attempts AND locked_at IS NULL
         AND updated_at >= now() - ($1::bigint * interval '1 millisecond')`,
      [FAILED_JOB_RETENTION_MS],
    );
    const count = Number(rows[0]?.count ?? 0);
    const transition = await transitionObservabilityCheck(client, checkKey, () => ({
      status: count > 0 ? "alerting" : "ok",
      detail: { count },
    }));
    if (transition.transitionedToAlerting) {
      await writeOperatorAlert(pool, client, {
        kind: "queue_backlog",
        checkId: transition.id,
        transitionInstance: `${helpers.job.id}:${checkKey}`,
        payload: { count },
      });
    }
  });
}

const MAIL_CHECK_KEY_PREFIX = "mail:";

/**
 * One `mail:<mailboxItemId>` check per mailbox of the *current tenant*, folding both adapter-owned
 * inputs into the single uniform predicate `mail_account_sync_state`'s own migration comment already
 * documents: overdue `next_expected_activity_at` (set identically by the imap/gmail_api/graph_api
 * adapters, so this check has no provider-specific branch) OR a non-null `last_error`.
 *
 * Must run inside a tenant scope (`forEachActiveTenant`): the sync-state read, the check rows and
 * their `tenant_id` all come from RLS and the column default. The rows live in
 * `tenant_observability_checks`, so `detail` may carry the provider's `lastError`. The user-facing
 * `mail_sync_stalled` notification never does: its payload is `{ mailboxItemId, reason }` where `reason`
 * is the stored failure kind, or `other` when the check alerts only because the sync is overdue.
 * On the alerting transition it also raises the mailbox's Semp problem under `mail:<id>`, and on the
 * return to `ok` it resolves that problem (issue #1506).
 *
 * `mail_account_sync_state` has no FK to `tenant_observability_checks`, so a deleted mail account
 * simply stops appearing in `listAllMailAccountSyncStates` — its `mail:<itemId>` row would otherwise
 * never be re-evaluated again and could sit `alerting` forever.
 * `deleteOrphanedTenantObservabilityChecks` drops any `mail:` row of this tenant whose account is
 * no longer present before this tick's checks run.
 */
async function checkMailSync(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const accounts = await withTransaction(pool, (client) => listAllMailAccountSyncStates(client));
  const currentCheckKeys = accounts.map((account) => `${MAIL_CHECK_KEY_PREFIX}${account.itemId}`);
  await withTransaction(pool, (client) =>
    deleteOrphanedTenantObservabilityChecks(client, MAIL_CHECK_KEY_PREFIX, currentCheckKeys),
  );
  for (const snapshot of accounts) {
    const checkKey = `${MAIL_CHECK_KEY_PREFIX}${snapshot.itemId}`;
    await withTransaction(pool, async (client) => {
      const account = await lockMailAccountSyncState(client, snapshot.itemId);
      if (!account) return;
      const overdue =
        account.nextExpectedActivityAt !== null && new Date(account.nextExpectedActivityAt).getTime() < Date.now();
      const alerting = overdue || account.lastError !== null;
      const transition = await transitionTenantObservabilityCheck(client, checkKey, () => ({
        status: alerting ? "alerting" : "ok",
        detail: {
          mailboxItemId: account.itemId,
          nextExpectedActivityAt: account.nextExpectedActivityAt,
          lastError: account.lastError,
        },
      }));
      if (transition.transitionedToAlerting) {
        await notifyMailSyncStalled(client, helpers, checkKey, transition.id, {
          mailboxItemId: account.itemId,
          reason: account.lastFailureKind ?? "other",
        });
        await raiseMailSyncProblem(client, helpers, checkKey, account);
      } else if (transition.previousStatus === "alerting" && transition.status === "ok") {
        await resolveProblem(client, { dedupeKey: mailProblemKey(account.itemId), resolutionKind: "recovered" });
      }
    });
  }
}

/**
 * `observability.checkSystem` (issue #169), registered against the queue's cron table at a
 * static "every minute" entry (`CORE_CRONTAB` in worker.ts), same shape as `HEARTBEAT_SWEEP`.
 * The process, backlog and failed-job families upsert content-free `observability_checks` rows from
 * the system scope the task runner provides. Process liveness is global only for the four fixed
 * processes; each mailbox's `mailsync:<id>` liveness, like its sync-stall check, runs once per active
 * tenant (`forEachActiveTenant`) against `tenant_observability_checks`. Any legacy global `mail:` and
 * `process:mailsync:` rows are purged first so a rollback-and-forward cannot leave a stale
 * `lastError` or a mailbox id in the global table. If any
 * tenant's pass fails the handler rejects, but only after every tenant was attempted. Each family
 * notifies only on a genuine ok/missing -> alerting transition, so a sustained fault across many ticks —
 * or across a restart of whatever process runs this crontab, since the state lives in Postgres,
 * not memory — notifies exactly once until it recovers. The exception is an operator alert whose
 * write fails for one admin: `writeOperatorAlert` rolls that transition back, so the next tick re-alerts
 * the admins already written until every admin's write succeeds (see its docstring).
 */
export async function handleObservabilityCheckSystemTask(
  pool: Pool,
  helpers: ObservabilityCheckSystemHelpers,
): Promise<void> {
  await checkProcessHeartbeats(pool, helpers);
  await checkQueueBacklog(pool, helpers);
  await checkPermanentlyFailedJobs(pool, helpers);
  await withTransaction(pool, (client) => deleteOrphanedObservabilityChecks(client, MAIL_CHECK_KEY_PREFIX, []));
  await withTransaction(pool, (client) =>
    deleteOrphanedObservabilityChecks(client, MAIL_SYNC_PROCESS_CHECK_PREFIX, []),
  );
  await forEachActiveTenant(pool, async () => {
    await checkMailSync(pool, helpers);
    await checkMailSyncLiveness(pool, helpers);
  });
}
