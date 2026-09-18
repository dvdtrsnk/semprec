import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureMailAccountSyncState, getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { handleGraphChangeNotification } from "../mail/graphWebhookNotifications.js";
import { logger } from "../mail/logger.js";
import {
  createGraphWebhookLifecycleFactory,
  GraphSubscriptionNotFoundError,
  type GraphSubscriptionRegistration,
  type GraphSubscriptionTransport,
} from "../mail/graphWebhookLifecycle.js";

let pool: Pool;

const NOTIFICATION_URL = "https://app.example.test/api/mail/graph/webhook";

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** A real Mailbox item — `mail_account_sync_state.item_id` is a foreign key, so a plain string id is rejected. */
async function createMailboxItem(name: string): Promise<string> {
  const mailboxesId = await databaseIdFor("mailboxes");
  const item = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: mailboxesId, properties: { name, provider: "outlook" } }),
  );
  return item.id;
}

async function pendingMailSyncJobCount(mailboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'mailAccountSync' AND j.key = $1`,
    [`mail-account-sync:${mailboxItemId}`],
  );
  return Number(rows[0]?.count ?? 0);
}

interface FakeTransportOptions {
  createSubscription?: (
    mailboxItemId: string,
    credential: string,
    params: { notificationUrl: string; clientState: string },
  ) => GraphSubscriptionRegistration | Promise<GraphSubscriptionRegistration>;
  renewSubscription?: (
    mailboxItemId: string,
    credential: string,
    subscriptionId: string,
  ) => GraphSubscriptionRegistration | Promise<GraphSubscriptionRegistration>;
}

function createFakeTransport(options: FakeTransportOptions = {}): {
  transport: GraphSubscriptionTransport;
  createCalls: Array<{ mailboxItemId: string; credential: string; clientState: string }>;
  renewCalls: Array<{ mailboxItemId: string; credential: string; subscriptionId: string }>;
} {
  const createCalls: Array<{ mailboxItemId: string; credential: string; clientState: string }> = [];
  const renewCalls: Array<{ mailboxItemId: string; credential: string; subscriptionId: string }> = [];

  const transport: GraphSubscriptionTransport = {
    async createSubscription(mailboxItemId, credential, params) {
      createCalls.push({ mailboxItemId, credential, clientState: params.clientState });
      if (options.createSubscription) return options.createSubscription(mailboxItemId, credential, params);
      return { subscriptionId: `sub-${createCalls.length}`, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    },
    async renewSubscription(mailboxItemId, credential, subscriptionId) {
      renewCalls.push({ mailboxItemId, credential, subscriptionId });
      if (options.renewSubscription) return options.renewSubscription(mailboxItemId, credential, subscriptionId);
      return { subscriptionId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    },
  };

  return { transport, createCalls, renewCalls };
}

describe("Microsoft Graph webhook subscription lifecycle (issue #198)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers a brand-new subscription with a freshly generated clientState on the very first start", async () => {
    const mailboxItemId = await createMailboxItem("A");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    const { transport, createCalls } = createFakeTransport();
    const factory = createGraphWebhookLifecycleFactory(pool, transport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "graph_api" });

    await lifecycle.start();
    await vi.waitFor(async () => {
      const state = await getMailAccountSyncState(pool, mailboxItemId);
      expect(state?.graphSubscriptionId).toBe("sub-1");
    });
    expect(createCalls.length).toBe(1);
    const firstCreateCall = createCalls[0];
    if (!firstCreateCall) throw new Error("expected a createSubscription call to have been recorded");
    expect(firstCreateCall.clientState).toHaveLength(64); // 32 random bytes, hex-encoded
    const state = await getMailAccountSyncState(pool, mailboxItemId);
    expect(state?.graphClientState).toBe(firstCreateCall.clientState);

    await lifecycle.stop();
  });

  it("restart reuses the already-persisted subscription id and renews it instead of registering a second one", async () => {
    const mailboxItemId = await createMailboxItem("B");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    const { transport: firstTransport } = createFakeTransport();
    const factory1 = createGraphWebhookLifecycleFactory(pool, firstTransport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
    });
    const lifecycle1 = factory1({ mailboxItemId, syncMode: "graph_api" });
    await lifecycle1.start();
    await vi.waitFor(async () => {
      expect((await getMailAccountSyncState(pool, mailboxItemId))?.graphSubscriptionId).toBe("sub-1");
    });
    await lifecycle1.stop();

    // A fresh process/lifecycle instance, as a real restart would produce — nothing carried in
    // memory, only what's persisted in `mail_account_sync_state`.
    const { transport: secondTransport, createCalls, renewCalls } = createFakeTransport();
    const factory2 = createGraphWebhookLifecycleFactory(pool, secondTransport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
    });
    const lifecycle2 = factory2({ mailboxItemId, syncMode: "graph_api" });
    await lifecycle2.start();
    await vi.waitFor(() => expect(renewCalls.length).toBe(1));
    const firstRenewCall = renewCalls[0];
    if (!firstRenewCall) throw new Error("expected a renewSubscription call to have been recorded");
    expect(firstRenewCall.subscriptionId).toBe("sub-1");
    expect(createCalls.length).toBe(0);

    await lifecycle2.stop();
  });

  it("falls back to registering a fresh subscription when a renewal reports the old one no longer exists", async () => {
    const mailboxItemId = await createMailboxItem("C");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    const { transport: firstTransport } = createFakeTransport();
    const factory1 = createGraphWebhookLifecycleFactory(pool, firstTransport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
    });
    const lifecycle1 = factory1({ mailboxItemId, syncMode: "graph_api" });
    await lifecycle1.start();
    await vi.waitFor(async () => {
      expect((await getMailAccountSyncState(pool, mailboxItemId))?.graphSubscriptionId).toBe("sub-1");
    });
    await lifecycle1.stop();

    const { transport, createCalls, renewCalls } = createFakeTransport({
      renewSubscription: async () => {
        throw new GraphSubscriptionNotFoundError("gone");
      },
    });
    const factory2 = createGraphWebhookLifecycleFactory(pool, transport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
    });
    const lifecycle2 = factory2({ mailboxItemId, syncMode: "graph_api" });
    await lifecycle2.start();
    await vi.waitFor(() => expect(createCalls.length).toBe(1));
    expect(renewCalls.length).toBe(1);
    const state = await getMailAccountSyncState(pool, mailboxItemId);
    expect(state?.graphSubscriptionId).toBe("sub-1"); // fake transport's default id, reused across both fakes' call counters

    await lifecycle2.stop();
  });

  it("renews on the configured interval, replacing the persisted expiry each time without changing the subscription id", async () => {
    // Real timers, not fake ones: each renewal round makes a real DB write, and racing that real
    // I/O against a virtual clock is exactly the kind of flake this avoids by using a short real
    // interval and polling instead — same rationale as `gmailWatchLifecycle.test.ts`'s own
    // renewal-cadence test.
    const mailboxItemId = await createMailboxItem("D");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    let call = 0;
    const { transport, renewCalls } = createFakeTransport({
      renewSubscription: async (_mailboxItemId, _credential, subscriptionId) => {
        call++;
        return { subscriptionId, expiresAt: new Date(Date.now() + call * 1000) };
      },
    });
    const factory = createGraphWebhookLifecycleFactory(pool, transport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
      renewalIntervalMs: 10,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "graph_api" });

    await lifecycle.start();
    await vi.waitFor(() => expect(renewCalls.length).toBeGreaterThanOrEqual(3));

    await lifecycle.stop();
  });

  it("stop() halts the renewal loop so no further subscription calls happen", async () => {
    const mailboxItemId = await createMailboxItem("E");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    const { transport, createCalls } = createFakeTransport();
    const factory = createGraphWebhookLifecycleFactory(pool, transport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
      renewalIntervalMs: 20,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "graph_api" });

    await lifecycle.start();
    await vi.waitFor(() => expect(createCalls.length).toBe(1));

    await lifecycle.stop();
    const callsAfterStop = createCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(createCalls.length).toBe(callsAfterStop);
  });

  it("logs a failed registration when the caller passed no onError handler, instead of swallowing it", async () => {
    const mailboxItemId = await createMailboxItem("E2");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    const failure = new Error("Graph rejected the subscription");
    const { transport } = createFakeTransport({
      createSubscription: () => {
        throw failure;
      },
    });
    // No `onError`: the renewal loop's catch has nowhere to report to but the logger, and a
    // subscription that never registers must not fail silently just because the caller left the
    // optional handler out.
    const factory = createGraphWebhookLifecycleFactory(pool, transport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
      renewalIntervalMs: 20,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "graph_api" });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);

    try {
      await lifecycle.start();
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({ err: failure, mailboxItemId });
      expect((await getMailAccountSyncState(pool, mailboxItemId))?.graphSubscriptionId).toBeNull();
    } finally {
      await lifecycle.stop();
      errorSpy.mockRestore();
    }
  });

  it("enqueues an immediate reconcile on start", async () => {
    const mailboxItemId = await createMailboxItem("F");
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    const { transport } = createFakeTransport();
    const factory = createGraphWebhookLifecycleFactory(pool, transport, {
      getCredential: async () => "access-token",
      notificationUrl: NOTIFICATION_URL,
    });
    const lifecycle = factory({ mailboxItemId, syncMode: "graph_api" });

    await lifecycle.start();
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);

    await lifecycle.stop();
  });
});

describe("handleGraphChangeNotification (issue #198)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  /** Registers a subscription directly with plain SQL: `graphWebhookLifecycle.test.ts`'s own describe block above already covers registration through the real factory — this block only needs a row in place to exercise `handleGraphChangeNotification`'s own dedup/rejection behavior. */
  async function createRegisteredMailbox(subscriptionId: string, clientState: string): Promise<string> {
    const mailboxItemId = await createMailboxItem(`mbx-${subscriptionId}`);
    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "graph_api" });
    await pool.query(
      `UPDATE mail_account_sync_state SET graph_subscription_id = $2, graph_subscription_expires_at = now() + interval '1 day', graph_client_state = $3 WHERE item_id = $1`,
      [mailboxItemId, subscriptionId, clientState],
    );
    return mailboxItemId;
  }

  it("accepts a matching notification and durably hands it off to the idempotent sync job", async () => {
    const mailboxItemId = await createRegisteredMailbox("sub-accept", "sub-accept".repeat(8));
    const outcome = await handleGraphChangeNotification(pool, {
      subscriptionId: "sub-accept",
      clientState: "sub-accept".repeat(8),
    });
    expect(outcome).toBe("accepted");
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);
  });

  it("deduplicates repeated notifications for the same account through the job's own jobKey", async () => {
    const mailboxItemId = await createRegisteredMailbox("sub-dup", "sub-dup".repeat(8));
    await handleGraphChangeNotification(pool, { subscriptionId: "sub-dup", clientState: "sub-dup".repeat(8) });
    await handleGraphChangeNotification(pool, { subscriptionId: "sub-dup", clientState: "sub-dup".repeat(8) });
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(1);
  });

  it("rejects a notification whose clientState doesn't match, and enqueues nothing", async () => {
    const mailboxItemId = await createRegisteredMailbox("sub-bad", "sub-bad".repeat(8));
    const outcome = await handleGraphChangeNotification(pool, { subscriptionId: "sub-bad", clientState: "wrong" });
    expect(outcome).toBe("invalidClientState");
    expect(await pendingMailSyncJobCount(mailboxItemId)).toBe(0);
  });

  it("rejects a notification with no clientState at all", async () => {
    await createRegisteredMailbox("sub-missing", "sub-missing".repeat(8));
    const outcome = await handleGraphChangeNotification(pool, { subscriptionId: "sub-missing" });
    expect(outcome).toBe("invalidClientState");
  });

  it("rejects a notification for a subscriptionId this deployment never registered", async () => {
    const outcome = await handleGraphChangeNotification(pool, {
      subscriptionId: "never-registered",
      clientState: "anything",
    });
    expect(outcome).toBe("unknownSubscription");
  });
});
