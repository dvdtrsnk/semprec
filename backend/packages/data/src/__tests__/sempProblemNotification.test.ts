import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { writeNotification } from "../notifications/notify.js";
import { handleNotificationFanoutTask } from "../notifications/notificationFanoutJob.js";
import type { NotificationKind } from "../notifications/notificationKinds.js";
import { patchNotificationPreferences } from "../notifications/notificationPreferencesStore.js";
import { upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import type { PushSenders } from "../push/pushSenders.js";
import { raiseProblem, type RaiseProblemInput } from "../semp/sempProblemsStore.js";

class RollbackSentinel extends Error {}

/** The problem sources whose own notification is stored for the in-app list and never pushed (issue #1466). */
const SOURCE_KINDS = [
  "mail_sync_error",
  "mail_sync_stalled",
  "backup_restore_failed",
  "process_stale",
  "agent_run_error",
  "heartbeat_error",
  "automation_error",
  "agent_guidance_drift",
  "queue_backlog",
  "agent_guidance_drift_resolved",
] as const satisfies readonly NotificationKind[];

let pool: Pool;
let tenantZero: string;
let userId: string;

/** Runs `fn` in a transaction scoped to tenant zero and commits it. */
function inZero<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, tenantZero, fn);
}

function problemInput(overrides: Partial<RaiseProblemInput> = {}): RaiseProblemInput {
  return {
    userId,
    category: "mail",
    kind: "mailSyncError",
    severity: "critical",
    sourceTable: "mail_account_sync_state",
    sourceId: randomUUID(),
    dedupeKey: `mail:${randomUUID()}`,
    ...overrides,
  };
}

interface SempNotificationRow {
  id: string;
  user_id: string;
  title: string;
  source_id: string;
  transition_instance: string;
  link_href: string | null;
  payload: { severity?: string };
}

/** Every `semp_problem` notification of tenant zero, oldest first. */
async function sempNotifications(): Promise<SempNotificationRow[]> {
  const { rows } = await inZero((client) =>
    client.query<SempNotificationRow>(
      `SELECT id, user_id, title, source_id, transition_instance, link_href, payload
         FROM notifications WHERE kind = 'semp_problem' ORDER BY created_at, id`,
    ),
  );
  return rows;
}

async function countInZero(text: string, values: unknown[] = []): Promise<number> {
  const { rows } = await inZero((client) => client.query<{ count: string }>(text, values));
  return Number(rows[0]?.count ?? 0);
}

/** Runs the fanout job for every notification of tenant zero, oldest first, as the queue would. */
async function fanOutAll(senders: PushSenders): Promise<void> {
  const { rows } = await inZero((client) =>
    client.query<{ id: string }>(`SELECT id FROM notifications ORDER BY created_at, id`),
  );
  for (const row of rows) {
    await runInTenant(tenantZero, () => handleNotificationFanoutTask(pool, { notificationId: row.id }, senders));
  }
}

describe("semp_problem notifications raised by raiseProblem (issue #1466)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantZero = getTenantZeroId();
    userId = (await createTenantZeroUser(pool)).id;
    await inZero((client) =>
      upsertWebPushSubscription(client, {
        userId,
        sessionId: null,
        endpoint: `https://push.example/${randomUUID()}`,
        p256dh: "p256dh-key",
        authSecret: "auth-secret",
      }),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("writes one notification for a new critical problem and sends it as one push", async () => {
    const { problemId, outcome } = await inZero((client) => raiseProblem(client, problemInput()));

    expect(outcome).toBe("created");
    const notifications = await sempNotifications();
    expect(notifications).toEqual([
      {
        id: expect.any(String),
        user_id: userId,
        title: expect.any(String),
        source_id: problemId,
        transition_instance: `${problemId}:critical`,
        link_href: `?page=semp-status&id=${problemId}`,
        payload: { severity: "critical" },
      },
    ]);
    // The catalog resolved the title; a missing entry would leave the raw key in the row.
    expect(notifications[0]?.title).not.toMatch(/^notification\./);

    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    await fanOutAll({ sendWebPush, sendApns: vi.fn() });

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(sendWebPush).toHaveBeenCalledWith(expect.anything(), {
      notificationId: notifications[0]?.id,
      title: expect.any(String),
      linkHref: `?page=semp-status&id=${problemId}`,
      interruptionLevel: "time-sensitive",
    });
  });

  /**
   * Four failed syncs of one mailbox, as `mailSyncJob` reports them: each stores its own
   * `mail_sync_error` notification and raises the mailbox's one problem at `severity`.
   */
  async function reportFourSyncFailures(severity: "critical" | "warning"): Promise<void> {
    const mailboxId = randomUUID();
    const dedupeKey = `mail:${mailboxId}`;
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const outcome = await inZero(async (client) => {
        await writeNotification(client, {
          userId,
          kind: "mail_sync_error",
          linkHref: `?page=mailbox&id=${mailboxId}`,
          sourceTable: "mail_account_sync_state",
          sourceId: mailboxId,
          transitionInstance: `job-${attempt}`,
        });
        const result = await raiseProblem(
          client,
          problemInput({ sourceId: mailboxId, dedupeKey, severity, occurrenceKey: `job-${attempt}` }),
        );
        return result.outcome;
      });
      outcomes.push(outcome);
    }

    expect(outcomes).toEqual(["created", "merged", "merged", "merged"]);
    const { rows: problems } = await inZero((client) =>
      client.query<{ occurrence_count: number }>(`SELECT occurrence_count FROM semp_problems WHERE dedupe_key = $1`, [
        dedupeKey,
      ]),
    );
    expect(problems).toEqual([{ occurrence_count: 4 }]);
    expect(await sempNotifications()).toHaveLength(1);
    expect(await countInZero(`SELECT count(*) FROM notifications WHERE kind = 'mail_sync_error'`)).toBe(4);
  }

  it("merges four critical sync failures of one mailbox into one problem, one notification and one push", async () => {
    await reportFourSyncFailures("critical");

    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    await fanOutAll({ sendWebPush, sendApns: vi.fn() });

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(await countInZero(`SELECT count(*) FROM push_deliveries`)).toBe(1);
  });

  it("sends one push for four warning sync failures only when the problems level includes warnings", async () => {
    await reportFourSyncFailures("warning");

    // Under the default critical level a warning problem is stored and not pushed.
    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    await fanOutAll({ sendWebPush, sendApns: vi.fn() });
    expect(sendWebPush).not.toHaveBeenCalled();

    await inZero((client) => patchNotificationPreferences(client, userId, { problemsLevel: "all" }));
    await fanOutAll({ sendWebPush, sendApns: vi.fn() });
    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(await countInZero(`SELECT count(*) FROM push_deliveries`)).toBe(1);
  });

  it("writes nothing new when the same problem is raised again at the same or a lower severity", async () => {
    const sourceId = randomUUID();
    const dedupeKey = `mail:${sourceId}`;
    const outcomes: string[] = [];
    for (const [attempt, severity] of [
      [1, "critical"],
      [2, "critical"],
      [3, "warning"],
    ] as const) {
      const result = await inZero((client) =>
        raiseProblem(client, problemInput({ sourceId, dedupeKey, severity, occurrenceKey: `job-${attempt}` })),
      );
      outcomes.push(result.outcome);
    }

    expect(outcomes).toEqual(["created", "merged", "merged"]);
    expect(await sempNotifications()).toHaveLength(1);
  });

  it("writes one new notification when a problem's severity rises from warning to critical", async () => {
    const sourceId = randomUUID();
    const dedupeKey = `mail:${sourceId}`;
    const first = await inZero((client) =>
      raiseProblem(client, problemInput({ sourceId, dedupeKey, severity: "warning" })),
    );
    const second = await inZero((client) =>
      raiseProblem(client, problemInput({ sourceId, dedupeKey, severity: "critical", occurrenceKey: "job-2" })),
    );

    expect(first.outcome).toBe("created");
    expect(second).toEqual({ problemId: first.problemId, outcome: "escalated" });
    const notifications = await sempNotifications();
    expect(notifications.map((row) => [row.transition_instance, row.payload.severity])).toEqual([
      [`${first.problemId}:warning`, "warning"],
      [`${first.problemId}:critical`, "critical"],
    ]);

    // The default preferences push a critical problem only: the warning is stored and not sent.
    const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
    await fanOutAll({ sendWebPush, sendApns: vi.fn() });

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(sendWebPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notificationId: notifications[1]?.id, interruptionLevel: "time-sensitive" }),
    );
  });

  it("writes no problem and no notification when the caller's transaction rolls back", async () => {
    await expect(
      inZero(async (client) => {
        await raiseProblem(client, problemInput());
        throw new RollbackSentinel("caller rolls back");
      }),
    ).rejects.toBeInstanceOf(RollbackSentinel);

    expect(await countInZero(`SELECT count(*) FROM semp_problems`)).toBe(0);
    expect(await sempNotifications()).toHaveLength(0);
  });

  it("keeps the kind check accepting semp_problem (migration 0121)", async () => {
    const { rows } = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'notifications_kind_check' AND conrelid = 'notifications'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain("'semp_problem'");
  });

  it.each(SOURCE_KINDS)(
    "stores a %s notification and never pushes it, even when every problems level passes",
    async (kind) => {
      await inZero((client) => patchNotificationPreferences(client, userId, { problemsLevel: "all" }));
      const sourceId = randomUUID();
      await inZero((client) =>
        writeNotification(client, {
          userId,
          kind,
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId,
          transitionInstance: "job-1",
        }),
      );

      const sendWebPush = vi.fn().mockResolvedValue({ outcome: "delivered" });
      await fanOutAll({ sendWebPush, sendApns: vi.fn() });

      expect(sendWebPush).not.toHaveBeenCalled();
      expect(await countInZero(`SELECT count(*) FROM notifications WHERE source_id = $1`, [sourceId])).toBe(1);
      expect(await countInZero(`SELECT count(*) FROM push_deliveries`)).toBe(0);
    },
  );
});
