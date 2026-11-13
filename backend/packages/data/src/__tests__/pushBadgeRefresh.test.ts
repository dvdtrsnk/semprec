import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { createPendingApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { computeBadgeForUser } from "../notifications/badgeCount.js";
import { handleNotificationFanoutTask } from "../notifications/notificationFanoutJob.js";
import { createPatchNotificationPreferencesRouteHandler } from "../notifications/notificationPreferencesRoutes.js";
import { writeNotification } from "../notifications/notify.js";
import * as apnsAdapter from "../push/apnsAdapter.js";
import { BADGE_REFRESH_DELAY_MS, enqueueBadgeRefresh } from "../push/badgeRefreshEnqueue.js";
import { handlePushBadgeRefreshTask } from "../push/pushBadgeRefreshJob.js";
import type { PushBadgeSenders, PushSendResult, PushSenders } from "../push/pushSenders.js";
import { upsertApnsSubscription, upsertWebPushSubscription } from "../push/pushSubscriptionsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Passthrough spy: every call reaches the real adapter unless a test replaces one answer, so the default wiring of
// the job to the adapter can be observed without a network.
vi.mock("../push/apnsAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../push/apnsAdapter.js")>();
  return { ...actual, sendApnsBadgeUpdate: vi.fn(actual.sendApnsBadgeUpdate) };
});

/**
 * Issue #1891: the badge on visible pushes and the debounced badge-only refresh. Every write goes through the
 * production stores and route handlers on a `semprec_data` pool, so row-level security applies; each tenant has one
 * user. The job runs through its production handler drained with `runOnce`, with a fake sender in place of APNs.
 * Only `Date` is faked in the queue tests, which makes the run time of a job a known instant and leaves every job
 * due when it is drained, because graphile-worker compares `run_at` with the database clock.
 */

const jobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ userId: z.string() }) });

const APPROVAL_PAYLOAD = { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} };

interface BadgeTenant {
  tenantId: string;
  userId: string;
  apns: { id: string; deviceToken: string };
  webPush: { id: string };
}

let adminPool: Pool;
let dataPool: Pool;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** A new tenant with its one user, one APNs registration and one Web Push registration. */
async function newTenant(): Promise<BadgeTenant> {
  const tenantId = await createTestTenant(adminPool);
  const user = await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    locale: "en",
  });
  const deviceToken = randomUUID();
  const apns = await runInTenant(tenantId, () =>
    upsertApnsSubscription(dataPool, {
      userId: user.id,
      sessionId: null,
      platform: "ios",
      deviceToken,
      apnsEnvironment: "sandbox",
    }),
  );
  const webPush = await runInTenant(tenantId, () =>
    upsertWebPushSubscription(dataPool, {
      userId: user.id,
      sessionId: null,
      endpoint: `https://push.example/${randomUUID()}`,
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
    }),
  );
  return { tenantId, userId: user.id, apns: { id: apns.id, deviceToken }, webPush: { id: webPush.id } };
}

/** One more active APNs registration for the user of `tenant`. */
async function addApnsRegistration(tenant: BadgeTenant): Promise<{ id: string; deviceToken: string }> {
  const deviceToken = randomUUID();
  const registration = await runInTenant(tenant.tenantId, () =>
    upsertApnsSubscription(dataPool, {
      userId: tenant.userId,
      sessionId: null,
      platform: "ios",
      deviceToken,
      apnsEnvironment: "production",
    }),
  );
  return { id: registration.id, deviceToken };
}

/** A new pending approval request of a new run of the user of `tenant`, created the way production creates one. */
function createRequest(tenant: BadgeTenant, toolCallId?: string) {
  return inTenant(tenant.tenantId, async (client) => {
    const run = await createAgentRun(client, { triggeredBy: "user", task: "badge refresh", userId: tenant.userId });
    return createPendingApprovalRequest(client, {
      agentRunId: run.id,
      toolName: "search_web",
      riskClass: "unclassified",
      payload: APPROVAL_PAYLOAD,
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      toolCallId: toolCallId ?? null,
    });
  });
}

function decide(tenant: BadgeTenant, approvalRequestId: string, decision: "approved" | "rejected") {
  return inTenant(tenant.tenantId, (client) =>
    decideAndEnqueueApprovalRequest(client, { approvalRequestId, decision, decidedByUserId: tenant.userId }),
  );
}

/** PATCHes the notification preferences of `tenant`'s user through the production route handler. */
function patchPreferences(tenant: BadgeTenant, body: unknown) {
  return runInTenant(tenant.tenantId, () =>
    createPatchNotificationPreferencesRouteHandler(dataPool)({ body, identity: { user: { id: tenant.userId } } }),
  );
}

function badgeOf(tenant: BadgeTenant, userId = tenant.userId): Promise<number> {
  return inTenant(tenant.tenantId, (client) => computeBadgeForUser(client, userId));
}

interface PendingJob {
  key: string | null;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

/** The queued `pushBadgeRefresh` jobs, read through graphile-worker's public `jobs` view. */
async function refreshJobs(): Promise<PendingJob[]> {
  const { rows } = await adminPool.query<PendingJob>(
    `SELECT key, run_at, attempts, max_attempts, last_error
       FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key`,
    [CORE_TASK_NAMES.PUSH_BADGE_REFRESH],
  );
  return rows;
}

/** The envelopes of the queued `pushBadgeRefresh` jobs: the tenant each is stamped with and its payload. */
async function refreshEnvelopes() {
  return (await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.PUSH_BADGE_REFRESH))
    .map((envelope) => jobEnvelope.parse(envelope))
    .sort((a, b) => a.payload.userId.localeCompare(b.payload.userId));
}

/** Completes the queued jobs of every task but `pushBadgeRefresh`, through graphile-worker's public `complete_jobs`. */
async function discardOtherJobs(): Promise<void> {
  await adminPool.query(
    `SELECT graphile_worker.complete_jobs(
       ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL AND task_identifier <> $1))`,
    [CORE_TASK_NAMES.PUSH_BADGE_REFRESH],
  );
}

/** Completes every queued `pushBadgeRefresh` job without running it. */
async function discardRefreshJobs(): Promise<void> {
  await adminPool.query(
    `SELECT graphile_worker.complete_jobs(
       ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL AND task_identifier = $1))`,
    [CORE_TASK_NAMES.PUSH_BADGE_REFRESH],
  );
}

function senders(answer?: PushSendResult | ((deviceToken: string) => PushSendResult)) {
  return {
    sendApnsBadgeUpdate: vi
      .fn<PushBadgeSenders["sendApnsBadgeUpdate"]>()
      .mockImplementation(async (target) =>
        typeof answer === "function" ? answer(target.deviceToken) : (answer ?? { outcome: "delivered" }),
      ),
  };
}

function runRefresh(tenantId: string, payload: unknown, badgeSenders?: PushBadgeSenders): Promise<void> {
  return runInTenant(tenantId, () => handlePushBadgeRefreshTask(dataPool, payload, badgeSenders));
}

/** Drains the queue once with the production handler of `pushBadgeRefresh`; nothing else runs. */
async function drainRefreshJobs(badgeSenders: PushBadgeSenders): Promise<void> {
  await discardOtherJobs();
  await runOnce(
    { pgPool: adminPool },
    {
      [CORE_TASK_NAMES.PUSH_BADGE_REFRESH]: registerTask(CORE_TASK_NAMES.PUSH_BADGE_REFRESH, (payload) =>
        handlePushBadgeRefreshTask(dataPool, payload, badgeSenders),
      ),
    },
  );
}

/** The `revoked_at` state of every push registration of `tenant`'s user, by registration id. */
async function revoked(tenant: BadgeTenant): Promise<Record<string, boolean>> {
  const { rows } = await inTenant(tenant.tenantId, (client) =>
    client.query<{ id: string; revoked: boolean }>(
      "SELECT id, revoked_at IS NOT NULL AS revoked FROM push_subscriptions WHERE user_id = $1",
      [tenant.userId],
    ),
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.revoked]));
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  vi.mocked(apnsAdapter.sendApnsBadgeUpdate).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("computeBadgeForUser (issue #1891)", () => {
  it("is 3 with three pending approvals and the Inbox switch off", async () => {
    const tenant = await newTenant();
    await patchPreferences(tenant, { badgeInbox: false });
    for (let count = 0; count < 3; count += 1) await createRequest(tenant);

    expect(await badgeOf(tenant)).toBe(3);
  });

  it("counts approvals for a user who never saved preferences, which default to approvals on", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);
    await createRequest(tenant);

    expect(await badgeOf(tenant)).toBe(2);
  });

  it("is 0 when the approvals switch is off, although requests are pending", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);
    await createRequest(tenant);
    await patchPreferences(tenant, { badgeApprovals: false });

    expect(await badgeOf(tenant)).toBe(0);
  });

  it("is 0 when no switch is on, and again when every enabled count is 0", async () => {
    const tenant = await newTenant();
    await patchPreferences(tenant, { badgeApprovals: false, badgeInvites: false, badgeInbox: false });
    await createRequest(tenant);
    expect(await badgeOf(tenant)).toBe(0);

    await patchPreferences(tenant, { badgeApprovals: true });
    expect(await badgeOf(tenant)).toBe(1);

    const other = await newTenant();
    expect(await badgeOf(other)).toBe(0);
  });

  it("drops a request from the badge once it is decided", async () => {
    const tenant = await newTenant();
    const kept = await createRequest(tenant);
    const approved = await createRequest(tenant);
    const rejected = await createRequest(tenant);
    expect(await badgeOf(tenant)).toBe(3);

    await decide(tenant, approved.id, "approved");
    await decide(tenant, rejected.id, "rejected");

    expect(await badgeOf(tenant)).toBe(1);
    expect(kept.status).toBe("pending");
  });

  it("never includes another user's counts, which the runtime role cannot even see", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await createRequest(a);
    await createRequest(b);
    await createRequest(b);

    expect(await badgeOf(a)).toBe(1);
    expect(await badgeOf(b)).toBe(2);
    // Asking in A's scope for B's user reads B's preferences and counts through row-level security: nothing.
    expect(await badgeOf(a, b.userId)).toBe(0);
  });
});

describe("a visible push carries the badge (issue #1891)", () => {
  function fanoutSenders() {
    return {
      sendWebPush: vi.fn<PushSenders["sendWebPush"]>().mockResolvedValue({ outcome: "delivered" }),
      sendApns: vi.fn<PushSenders["sendApns"]>().mockResolvedValue({ outcome: "delivered" }),
    };
  }

  /** Writes a critical Semp problem notification for the tenant's user, a kind the default preferences push. */
  function writeCriticalProblem(tenant: BadgeTenant): Promise<string> {
    return inTenant(tenant.tenantId, (client) =>
      writeNotification(client, {
        userId: tenant.userId,
        kind: "semp_problem",
        linkHref: null,
        sourceTable: "semp_problems",
        sourceId: randomUUID(),
        transitionInstance: randomUUID(),
        payload: { severity: "critical" },
      }),
    );
  }

  async function pushWith(tenant: BadgeTenant) {
    const notificationId = await writeCriticalProblem(tenant);
    const pushSenders = fanoutSenders();
    await runInTenant(tenant.tenantId, () => handleNotificationFanoutTask(dataPool, { notificationId }, pushSenders));
    return pushSenders;
  }

  it("passes the sum of the enabled counts, 3 with approvals 3 and the Inbox switch off, to every registration", async () => {
    const tenant = await newTenant();
    const second = await addApnsRegistration(tenant);
    await patchPreferences(tenant, { badgeInbox: false });
    for (let count = 0; count < 3; count += 1) await createRequest(tenant);

    const pushSenders = await pushWith(tenant);

    expect(pushSenders.sendApns).toHaveBeenCalledTimes(2);
    expect(pushSenders.sendApns.mock.calls.map(([target]) => target.deviceToken).sort()).toEqual(
      [tenant.apns.deviceToken, second.deviceToken].sort(),
    );
    for (const [, payload] of pushSenders.sendApns.mock.calls) expect(payload.badge).toBe(3);
    expect(pushSenders.sendWebPush).toHaveBeenCalledTimes(1);
    expect(pushSenders.sendWebPush.mock.calls[0]?.[1].badge).toBe(3);
  });

  it("passes 0 when nothing is pending, which clears the badge instead of leaving it out", async () => {
    const tenant = await newTenant();

    const pushSenders = await pushWith(tenant);

    expect(pushSenders.sendApns).toHaveBeenCalledTimes(1);
    expect(pushSenders.sendApns.mock.calls[0]?.[1].badge).toBe(0);
  });

  it("passes 0 when requests are pending but the approvals switch is off", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);
    await patchPreferences(tenant, { badgeApprovals: false });

    const pushSenders = await pushWith(tenant);

    expect(pushSenders.sendApns.mock.calls[0]?.[1].badge).toBe(0);
  });

  it("leaves another tenant's pending requests out of the badge", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await createRequest(b);
    await createRequest(b);
    await createRequest(a);

    const pushSenders = await pushWith(a);

    expect(pushSenders.sendApns.mock.calls[0]?.[1].badge).toBe(1);
  });
});

describe("the badge refresh is enqueued when a count or a badge switch changes (issue #1891)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
  });

  it("enqueues one job for the user in their tenant, with the key badge-refresh:<userId> and the delay, when a request is created", async () => {
    const tenant = await newTenant();
    await discardRefreshJobs();

    await createRequest(tenant);

    expect(await refreshJobs()).toEqual([
      {
        key: `badge-refresh:${tenant.userId}`,
        run_at: new Date(Date.now() + BADGE_REFRESH_DELAY_MS),
        attempts: 0,
        max_attempts: 3,
        last_error: null,
      },
    ]);
    expect(await refreshEnvelopes()).toEqual([{ tenantId: tenant.tenantId, payload: { userId: tenant.userId } }]);
  });

  it("enqueues nothing for the replay of a tool call that already created its request", async () => {
    const tenant = await newTenant();
    const toolCallId = `call-${randomUUID()}`;
    const created = await createRequest(tenant);
    const run = await inTenant(tenant.tenantId, (client) =>
      client.query<{ agent_run_id: string }>("SELECT agent_run_id FROM approval_requests WHERE id = $1", [created.id]),
    );
    const agentRunId = run.rows[0]?.agent_run_id ?? "";
    const insertWithCall = () =>
      inTenant(tenant.tenantId, (client) =>
        createPendingApprovalRequest(client, {
          agentRunId,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: APPROVAL_PAYLOAD,
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
          toolCallId,
        }),
      );
    await insertWithCall();
    await discardRefreshJobs();

    const replayed = await insertWithCall();

    expect(replayed.toolCallId).toBe(toolCallId);
    expect(await refreshJobs()).toEqual([]);
  });

  it("leaves no job behind when the transaction that created the request rolls back", async () => {
    const tenant = await newTenant();
    await discardRefreshJobs();

    await expect(
      inTenant(tenant.tenantId, async (client) => {
        const run = await createAgentRun(client, { triggeredBy: "user", task: "rolled back", userId: tenant.userId });
        await createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: APPROVAL_PAYLOAD,
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await refreshJobs()).toEqual([]);
  });

  it.each(["approved", "rejected"] as const)(
    "enqueues one job for the owner when a request is %s",
    async (decision) => {
      const tenant = await newTenant();
      const request = await createRequest(tenant);
      await discardRefreshJobs();

      const result = await decide(tenant, request.id, decision);

      expect(result?.outcome).toBe("decided");
      expect((await refreshJobs()).map((job) => job.key)).toEqual([`badge-refresh:${tenant.userId}`]);
      expect(await refreshEnvelopes()).toEqual([{ tenantId: tenant.tenantId, payload: { userId: tenant.userId } }]);
    },
  );

  it("enqueues nothing when the decision finds the request already decided", async () => {
    const tenant = await newTenant();
    const request = await createRequest(tenant);
    await decide(tenant, request.id, "rejected");
    await discardRefreshJobs();

    const result = await decide(tenant, request.id, "approved");

    expect(result?.outcome).toBe("unchanged");
    expect(await refreshJobs()).toEqual([]);
  });

  it("enqueues nothing for a decision on an id that is not the caller's", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const ofB = await createRequest(b);
    await discardRefreshJobs();

    expect(await decide(a, ofB.id, "approved")).toBeNull();
    expect(await decide(a, randomUUID(), "approved")).toBeNull();

    expect(await refreshJobs()).toEqual([]);
  });

  it.each(["badgeApprovals", "badgeInvites", "badgeInbox"] as const)(
    "enqueues one job when a PATCH sets %s",
    async (field) => {
      const tenant = await newTenant();
      await discardRefreshJobs();

      const answer = await patchPreferences(tenant, { [field]: true });

      expect(answer.status).toBe(200);
      expect((await refreshJobs()).map((job) => job.key)).toEqual([`badge-refresh:${tenant.userId}`]);
      expect(await refreshEnvelopes()).toEqual([{ tenantId: tenant.tenantId, payload: { userId: tenant.userId } }]);
    },
  );

  it.each([
    ["a field that is not a badge switch", { approvals: false, problemsLevel: "all" }],
    ["an empty patch", {}],
  ])("enqueues nothing when a PATCH sets %s", async (_label, body) => {
    const tenant = await newTenant();
    await discardRefreshJobs();

    expect((await patchPreferences(tenant, body)).status).toBe(200);

    expect(await refreshJobs()).toEqual([]);
  });

  it("enqueues nothing when a PATCH is refused", async () => {
    const tenant = await newTenant();
    await discardRefreshJobs();

    await expect(patchPreferences(tenant, { badgeApprovals: "yes" })).rejects.toThrow(/boolean/);
    await expect(patchPreferences(tenant, { badgeApprovals: true, unknown: 1 })).rejects.toThrow(/Unknown field/);

    expect(await refreshJobs()).toEqual([]);
  });

  it("leaves one job, run the delay after the last change, when several changes follow one another", async () => {
    const tenant = await newTenant();
    await discardRefreshJobs();

    await createRequest(tenant);
    vi.setSystemTime(new Date("2020-01-01T00:00:02.000Z"));
    await createRequest(tenant);
    vi.setSystemTime(new Date("2020-01-01T00:00:03.000Z"));
    await patchPreferences(tenant, { badgeInbox: true });

    const jobs = await refreshJobs();
    expect(jobs.map((job) => job.key)).toEqual([`badge-refresh:${tenant.userId}`]);
    expect(jobs[0]?.run_at).toEqual(new Date("2020-01-01T00:00:08.000Z"));
  });

  it("keeps the jobs of two users apart", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await discardRefreshJobs();

    await createRequest(a);
    await createRequest(b);

    expect((await refreshJobs()).map((job) => job.key).sort()).toEqual(
      [`badge-refresh:${a.userId}`, `badge-refresh:${b.userId}`].sort(),
    );
    expect(await refreshEnvelopes()).toEqual(
      [
        { tenantId: a.tenantId, payload: { userId: a.userId } },
        { tenantId: b.tenantId, payload: { userId: b.userId } },
      ].sort((x, y) => x.payload.userId.localeCompare(y.payload.userId)),
    );
  });

  it("stamps the job with the tenant of the producer's scope", async () => {
    const tenant = await newTenant();
    await discardRefreshJobs();

    await inTenant(tenant.tenantId, (client) => enqueueBadgeRefresh(client, tenant.userId));

    expect(await refreshEnvelopes()).toEqual([{ tenantId: tenant.tenantId, payload: { userId: tenant.userId } }]);
  });
});

describe("the pushBadgeRefresh job through the queue (issue #1891)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
  });

  it("sends one badge-only push with the badge of the last state when several changes follow one another", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);
    vi.setSystemTime(new Date("2020-01-01T00:00:01.000Z"));
    await createRequest(tenant);
    vi.setSystemTime(new Date("2020-01-01T00:00:02.000Z"));
    await createRequest(tenant);
    const badgeSenders = senders();

    await drainRefreshJobs(badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(1);
    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledWith(
      { deviceToken: tenant.apns.deviceToken, apnsEnvironment: "sandbox" },
      3,
    );
    expect(await refreshJobs()).toEqual([]);
  });

  it("sends the new badge after a request is decided", async () => {
    const tenant = await newTenant();
    const first = await createRequest(tenant);
    await createRequest(tenant);
    await drainRefreshJobs(senders());
    await decide(tenant, first.id, "approved");
    const badgeSenders = senders();

    await drainRefreshJobs(badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(1);
    expect(badgeSenders.sendApnsBadgeUpdate.mock.calls[0]?.[1]).toBe(1);
  });

  it("sends a refreshed badge when a badge switch changes, 0 when the last count is switched off", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);
    await createRequest(tenant);
    await drainRefreshJobs(senders());
    await patchPreferences(tenant, { badgeApprovals: false });
    const badgeSenders = senders();

    await drainRefreshJobs(badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(1);
    expect(badgeSenders.sendApnsBadgeUpdate.mock.calls[0]?.[1]).toBe(0);
  });

  it("sends nothing before the delay has passed", async () => {
    // The real clock: the job's run time is the delay after the enqueue, which the database clock has not reached.
    vi.useRealTimers();
    const tenant = await newTenant();
    await createRequest(tenant);
    const badgeSenders = senders();

    await drainRefreshJobs(badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).not.toHaveBeenCalled();
    expect((await refreshJobs()).map((job) => job.key)).toEqual([`badge-refresh:${tenant.userId}`]);
  });

  it("keeps a job whose send failed transiently queued for a retry, with the failure recorded", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);

    await drainRefreshJobs(senders({ outcome: "transient-failure", error: new Error("503") }));

    expect(await refreshJobs()).toEqual([
      expect.objectContaining({ attempts: 1, max_attempts: 3, last_error: expect.stringMatching(/transient failure/) }),
    ]);
  });
});

describe("handlePushBadgeRefreshTask (issue #1891)", () => {
  it("sends the badge, computed when it runs, to the active APNs registrations only", async () => {
    const tenant = await newTenant();
    const second = await addApnsRegistration(tenant);
    const dead = await addApnsRegistration(tenant);
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE push_subscriptions SET revoked_at = now() WHERE id = $1", [dead.id]),
    );
    await createRequest(tenant);
    await createRequest(tenant);
    const badgeSenders = senders();

    await runRefresh(tenant.tenantId, { userId: tenant.userId }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(2);
    expect(badgeSenders.sendApnsBadgeUpdate.mock.calls.map(([target]) => target.deviceToken).sort()).toEqual(
      [tenant.apns.deviceToken, second.deviceToken].sort(),
    );
    for (const [, badge] of badgeSenders.sendApnsBadgeUpdate.mock.calls) expect(badge).toBe(2);
    expect(await revoked(tenant)).toEqual({
      [tenant.apns.id]: false,
      [tenant.webPush.id]: false,
      [second.id]: false,
      [dead.id]: true,
    });
  });

  it("sends 0 when nothing is pending, which clears the badge", async () => {
    const tenant = await newTenant();
    const badgeSenders = senders();

    await runRefresh(tenant.tenantId, { userId: tenant.userId }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(1);
    expect(badgeSenders.sendApnsBadgeUpdate.mock.calls[0]?.[1]).toBe(0);
  });

  it("sends nothing for a user whose only APNs registration is revoked", async () => {
    const tenant = await newTenant();
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE push_subscriptions SET revoked_at = now() WHERE id = $1", [tenant.apns.id]),
    );
    const badgeSenders = senders();

    await runRefresh(tenant.tenantId, { userId: tenant.userId }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).not.toHaveBeenCalled();
  });

  it("includes only the counts of its own user and sends only to the registrations of that user", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await createRequest(a);
    await createRequest(b);
    await createRequest(b);
    const badgeSenders = senders();

    await runRefresh(a.tenantId, { userId: a.userId }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(1);
    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledWith(
      { deviceToken: a.apns.deviceToken, apnsEnvironment: "sandbox" },
      1,
    );
  });

  it("sends nothing for a user of another tenant, and does not revoke or read that user's registrations", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await createRequest(a);
    const badgeSenders = senders({ outcome: "permanent-failure", error: "Unregistered" });

    // A job of B's tenant naming A's user: the registrations are not row-level secured, so the job itself must refuse.
    await runRefresh(b.tenantId, { userId: a.userId }, badgeSenders);
    await runRefresh(b.tenantId, { userId: randomUUID() }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).not.toHaveBeenCalled();
    expect(await revoked(a)).toEqual({ [a.apns.id]: false, [a.webPush.id]: false });
  });

  it("revokes a registration the provider reports dead, and still sends to the others", async () => {
    const tenant = await newTenant();
    const second = await addApnsRegistration(tenant);
    const badgeSenders = senders((deviceToken) =>
      deviceToken === tenant.apns.deviceToken
        ? { outcome: "permanent-failure", error: "Unregistered" }
        : { outcome: "delivered" },
    );

    await runRefresh(tenant.tenantId, { userId: tenant.userId }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(2);
    expect(await revoked(tenant)).toEqual({
      [tenant.apns.id]: true,
      [tenant.webPush.id]: false,
      [second.id]: false,
    });
  });

  it("neither revokes nor fails when APNs is not configured, and still tries every registration", async () => {
    const tenant = await newTenant();
    await addApnsRegistration(tenant);
    const badgeSenders = senders({ outcome: "not-configured", reason: "APNS_TEAM_ID is unset" });

    await runRefresh(tenant.tenantId, { userId: tenant.userId }, badgeSenders);

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(2);
    expect(Object.values(await revoked(tenant))).toEqual([false, false, false]);
  });

  it("throws after trying every registration when a send fails transiently, so the queue retries", async () => {
    const tenant = await newTenant();
    const second = await addApnsRegistration(tenant);
    const badgeSenders = senders((deviceToken) =>
      deviceToken === tenant.apns.deviceToken
        ? { outcome: "transient-failure", error: new Error("503") }
        : { outcome: "delivered" },
    );

    await expect(runRefresh(tenant.tenantId, { userId: tenant.userId }, badgeSenders)).rejects.toThrow(
      /1 transient failure/,
    );

    expect(badgeSenders.sendApnsBadgeUpdate).toHaveBeenCalledTimes(2);
    expect(await revoked(tenant)).toEqual({ [tenant.apns.id]: false, [tenant.webPush.id]: false, [second.id]: false });
  });

  it.each([
    ["not an object", "x"],
    ["a user id that is not a uuid", { userId: "not-a-uuid" }],
    ["a missing user id", {}],
    ["an extra field", { userId: randomUUID(), badge: 9 }],
  ])("fails the job without sending when the payload is %s", async (_label, payload) => {
    const tenant = await newTenant();
    const badgeSenders = senders();

    await expect(runRefresh(tenant.tenantId, payload, badgeSenders)).rejects.toThrow();

    expect(badgeSenders.sendApnsBadgeUpdate).not.toHaveBeenCalled();
  });

  it("sends through the APNs adapter's badge update by default", async () => {
    const tenant = await newTenant();
    await createRequest(tenant);
    // Neither APNS_* variable is set in the test environment, so the real adapter resolves not-configured
    // without a network request, which the job logs and accepts.
    const saved = {
      teamId: process.env.APNS_TEAM_ID,
      keyId: process.env.APNS_KEY_ID,
      keyPath: process.env.APNS_PRIVATE_KEY_PATH,
      topic: process.env.APNS_TOPIC,
    };
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_PRIVATE_KEY_PATH;
    delete process.env.APNS_TOPIC;
    try {
      await runRefresh(tenant.tenantId, { userId: tenant.userId });
    } finally {
      for (const [name, value] of [
        ["APNS_TEAM_ID", saved.teamId],
        ["APNS_KEY_ID", saved.keyId],
        ["APNS_PRIVATE_KEY_PATH", saved.keyPath],
        ["APNS_TOPIC", saved.topic],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    expect(apnsAdapter.sendApnsBadgeUpdate).toHaveBeenCalledTimes(1);
    expect(apnsAdapter.sendApnsBadgeUpdate).toHaveBeenCalledWith(
      { deviceToken: tenant.apns.deviceToken, apnsEnvironment: "sandbox" },
      1,
    );
  });
});
