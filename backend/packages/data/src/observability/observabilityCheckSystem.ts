import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getEarliestUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import type { NotificationKind } from "../notifications/notificationKinds.js";
import { getExpectedProcessHeartbeatStatuses } from "../health/processHeartbeats.js";
import { listAllMailAccountSyncStates } from "../mail/mailAccountSyncStateStore.js";
import {
  transitionObservabilityCheck,
  transitionTenantObservabilityCheck,
  deleteOrphanedObservabilityChecks,
  deleteOrphanedTenantObservabilityChecks,
  type ObservabilityCheckStatus,
} from "./observabilityChecksStore.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { FAILED_JOB_RETENTION_MS } from "./queueFailedJobsPrune.js";

export interface ObservabilityCheckSystemHelpers {
  /** The firing crontab job's own id — the stable base a retry of this same tick reuses, so a redelivery after a mid-transaction crash lands on the same `transitionInstance` as the attempt it's retrying, instead of a fresh one that would slip past `writeNotification`'s dedupe. */
  job: { id: string };
}

/** Silently skips before any account exists (setup, #233, not run yet) — same guard as `scheduler/sweep.ts`'s `notifyHeartbeatError`. */
async function notifyObservabilityAlert(
  client: PoolClient,
  helpers: ObservabilityCheckSystemHelpers,
  checkKey: string,
  checkId: string,
  kind: NotificationKind,
  detail: Record<string, unknown>,
  sourceTable: "observability_checks" | "tenant_observability_checks" = "observability_checks",
): Promise<void> {
  const userId = await getEarliestUserId(client);
  if (!userId) return;
  await writeNotification(client, {
    userId,
    kind,
    linkHref: null,
    sourceTable,
    sourceId: checkId,
    transitionInstance: `${helpers.job.id}:${checkKey}`,
    payload: detail,
  });
}

/** One `process:<name>` check per currently-expected process (`getExpectedProcessHeartbeatStatuses`) — stale beyond `process_heartbeats.ts`'s own 60s threshold is the fault, no further hysteresis needed on top of that. */
async function checkProcessHeartbeats(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const statuses = await withTransaction(pool, (client) => getExpectedProcessHeartbeatStatuses(client));
  for (const processStatus of statuses) {
    const checkKey = `process:${processStatus.process}`;
    await withTransaction(pool, async (client) => {
      const transition = await transitionObservabilityCheck(client, checkKey, () => ({
        status: processStatus.stale ? "alerting" : "ok",
        detail: { process: processStatus.process, present: processStatus.present, beatAt: processStatus.beatAt },
      }));
      if (transition.transitionedToAlerting) {
        await notifyObservabilityAlert(client, helpers, checkKey, transition.id, "process_stale", {
          process: processStatus.process,
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
      await notifyObservabilityAlert(client, helpers, checkKey, transition.id, "queue_backlog", {
        pending: snapshot.pending,
        oldestAgeMs: snapshot.oldestAgeMs,
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
      await notifyObservabilityAlert(client, helpers, checkKey, transition.id, "queue_backlog", { count });
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
 * `tenant_observability_checks`, so `detail` may carry the provider's `lastError`.
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
  for (const account of accounts) {
    const checkKey = `${MAIL_CHECK_KEY_PREFIX}${account.itemId}`;
    await withTransaction(pool, async (client) => {
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
        await notifyObservabilityAlert(
          client,
          helpers,
          checkKey,
          transition.id,
          "mail_sync_stalled",
          { mailboxItemId: account.itemId, lastError: account.lastError },
          "tenant_observability_checks",
        );
      }
    });
  }
}

/**
 * `observability.checkSystem` (issue #169), registered against the queue's cron table at a
 * static "every minute" entry (`CORE_CRONTAB` in worker.ts), same shape as `HEARTBEAT_SWEEP`.
 * The process, backlog and failed-job families upsert content-free `observability_checks` rows from
 * the system scope the task runner provides. The per-mailbox family runs once per active tenant
 * (`forEachActiveTenant`) against `tenant_observability_checks`; any legacy global `mail:` rows are
 * purged first so a rollback-and-forward cannot leave a stale `lastError` in the global table. If any
 * tenant's pass fails the handler rejects, but only after every tenant was attempted. Each family
 * notifies only on a genuine ok/missing -> alerting transition, so a sustained fault across many ticks —
 * or across a restart of whatever process runs this crontab, since the state lives in Postgres,
 * not memory — notifies exactly once until it recovers.
 */
export async function handleObservabilityCheckSystemTask(
  pool: Pool,
  helpers: ObservabilityCheckSystemHelpers,
): Promise<void> {
  await checkProcessHeartbeats(pool, helpers);
  await checkQueueBacklog(pool, helpers);
  await checkPermanentlyFailedJobs(pool, helpers);
  await withTransaction(pool, (client) => deleteOrphanedObservabilityChecks(client, MAIL_CHECK_KEY_PREFIX, []));
  await forEachActiveTenant(pool, () => checkMailSync(pool, helpers));
}
