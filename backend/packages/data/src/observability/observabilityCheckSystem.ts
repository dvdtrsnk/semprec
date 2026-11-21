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
  lockMailAccountStallState,
  type MailAccountStallState,
  type MailAccountSyncStateRow,
} from "../mail/mailAccountSyncStateStore.js";
import {
  transitionObservabilityCheck,
  transitionTenantObservabilityCheck,
  deleteOrphanedTenantObservabilityChecks,
  type ObservabilityCheckStatus,
} from "./observabilityChecksStore.js";
import { getTenantObservabilityCheckStatus } from "./tenantObservabilityCheckStatus.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { AGENTS_PROCESS_PROBLEM_KEY, mailProblemKey } from "../semp/sourceProblemKeys.js";
import { resolveOperatorAlertProblems, writeOperatorAlert } from "./operatorAlerts.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { FAILED_JOB_RETENTION_MS } from "./queueFailedJobsPrune.js";

export interface ObservabilityCheckSystemHelpers {
  /** Stable across retries of this tick, so a redelivery reuses the same `transitionInstance` and dedupes. */
  job: { id: string };
}

/**
 * How long a mailbox may be past its `next_expected_activity_at`, or go without a successful pass while its live-sync
 * heartbeat is stale, before it counts as stalled. An unfinished pass marks the account due at once; its follow-up, or
 * failing that the five-minute sweep, runs within this window.
 */
const MAIL_SYNC_STALL_GRACE_MS = 10 * 60_000;

/**
 * Both mailbox checks: while a pass holds the lease the check keeps its status (`ok` when it has none), so a pass in
 * flight is never reported stalled and an alerting check does not flap. A dead holder's lease expires.
 */
function mailboxCheckStatus(
  previousStatus: ObservabilityCheckStatus | null,
  account: MailAccountStallState,
  stalled: boolean,
): ObservabilityCheckStatus {
  if (account.passRunning) return previousStatus ?? "ok";
  return stalled ? "alerting" : "ok";
}

/**
 * Skips when the tenant has no bound user, or when `otherCheckKey`, the mailbox's other stall check, is alerting
 * already: that check notified for this episode. Must run inside the tenant's transaction, after the mailbox's sync
 * state row was locked, which both checks lock before their own row.
 */
async function notifyMailSyncStalled(
  client: PoolClient,
  helpers: ObservabilityCheckSystemHelpers,
  checkKey: string,
  checkId: string,
  otherCheckKey: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if ((await getTenantObservabilityCheckStatus(client, otherCheckKey)) === "alerting") return;
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
 * Uses the same `mail:<mailboxItemId>` key as the sync job so the two reports merge. Skipped
 * without a bound user. Must run inside the tenant's transaction.
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
 * Global checks for the fixed processes only; the heartbeat threshold is the hysteresis. Mailbox
 * liveness is per tenant, so no mailbox id reaches the global plane.
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
      } else if (
        processStatus.process === "agents" &&
        transition.previousStatus === "alerting" &&
        transition.status === "ok"
      ) {
        // The agents process beats again: close the problem the stale alert raised for each admin.
        await resolveOperatorAlertProblems(pool, client, AGENTS_PROCESS_PROBLEM_KEY);
      }
    });
  }
}

const MAIL_SYNC_PROCESS_CHECK_PREFIX = "process:mailsync:";
const MAIL_SYNC_PROCESS_PREFIX = "mailsync:";
const MAIL_CHECK_KEY_PREFIX = "mail:";

function mailCheckKey(mailboxItemId: string): string {
  return `${MAIL_CHECK_KEY_PREFIX}${mailboxItemId}`;
}

function livenessCheckKey(mailboxItemId: string): string {
  return `${MAIL_SYNC_PROCESS_CHECK_PREFIX}${mailboxItemId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Alerts on a stale or missing `mailsync:<id>` heartbeat only while no pass of the mailbox succeeded within the
 * grace. Must run inside a tenant scope. Rows of no-longer-active mailboxes are removed first so none can sit
 * `alerting` forever.
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
      const account = await lockMailAccountStallState(client, mailboxItemId, MAIL_SYNC_STALL_GRACE_MS);
      // The account was removed since the heartbeat statuses were read; the next tick drops its row.
      if (!account) return;
      const transition = await transitionTenantObservabilityCheck(client, checkKey, (previousStatus) => ({
        status: mailboxCheckStatus(previousStatus, account, processStatus.stale && !account.recentlySynced),
        detail: { process: processStatus.process, present: processStatus.present, beatAt: processStatus.beatAt },
      }));
      if (transition.transitionedToAlerting) {
        await notifyMailSyncStalled(client, helpers, checkKey, transition.id, mailCheckKey(mailboxItemId), {
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

/** Excludes permanently failed jobs (checked separately) so dead jobs do not look like a backlog. */
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
 * Hysteresis: alert when either metric passes its threshold, recover only when both are under
 * half, so a value between the bands keeps its state instead of flapping.
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
 * `attempts >= max_attempts`: the job needs a human. Locked rows are excluded because `add_jobs`
 * bumps `attempts` on a running job whose key is re-added. Rows older than
 * `FAILED_JOB_RETENTION_MS` are excluded (already alerted on, pruned daily), so the check recovers
 * on its own once no new failures appear.
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

/**
 * Alerts on a `next_expected_activity_at` overdue by more than the grace or a non-null `last_error`, with no
 * provider-specific branch. Must run inside a tenant scope. Tenant check rows may carry the
 * provider's `lastError` in `detail`; the user-facing notification never does (only a failure kind).
 *
 * There is no FK from sync state to check rows, so orphaned `mail:` rows of deleted accounts are
 * dropped first; otherwise they could sit `alerting` forever.
 */
async function checkMailSync(pool: Pool, helpers: ObservabilityCheckSystemHelpers): Promise<void> {
  const accounts = await withTransaction(pool, (client) => listAllMailAccountSyncStates(client));
  const currentCheckKeys = accounts.map((account) => mailCheckKey(account.itemId));
  await withTransaction(pool, (client) =>
    deleteOrphanedTenantObservabilityChecks(client, MAIL_CHECK_KEY_PREFIX, currentCheckKeys),
  );
  for (const snapshot of accounts) {
    const checkKey = mailCheckKey(snapshot.itemId);
    await withTransaction(pool, async (client) => {
      const account = await lockMailAccountStallState(client, snapshot.itemId, MAIL_SYNC_STALL_GRACE_MS);
      if (!account) return;
      const transition = await transitionTenantObservabilityCheck(client, checkKey, (previousStatus) => ({
        status: mailboxCheckStatus(previousStatus, account, account.overdue || account.lastError !== null),
        detail: {
          mailboxItemId: account.itemId,
          nextExpectedActivityAt: account.nextExpectedActivityAt,
          lastError: account.lastError,
        },
      }));
      if (transition.transitionedToAlerting) {
        await notifyMailSyncStalled(client, helpers, checkKey, transition.id, livenessCheckKey(account.itemId), {
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
 * Every-minute cron task. Global families write content-free `observability_checks` rows; mailbox
 * checks run per active tenant. A failing tenant rejects only after every tenant was attempted.
 *
 * State lives in Postgres, so a sustained fault notifies once per ok -> alerting transition, even
 * across restarts. Exception: a failed operator-alert write rolls the transition back, so the next
 * tick re-alerts (see `writeOperatorAlert`).
 */
export async function handleObservabilityCheckSystemTask(
  pool: Pool,
  helpers: ObservabilityCheckSystemHelpers,
): Promise<void> {
  await checkProcessHeartbeats(pool, helpers);
  await checkQueueBacklog(pool, helpers);
  await checkPermanentlyFailedJobs(pool, helpers);
  await forEachActiveTenant(pool, async () => {
    await checkMailSync(pool, helpers);
    await checkMailSyncLiveness(pool, helpers);
  });
}
