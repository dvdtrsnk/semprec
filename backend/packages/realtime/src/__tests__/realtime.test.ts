import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, type RawData } from "ws";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  setDocUpdateHook,
  setAgentRunEventHook,
  setInboxCardsInvalidationHook,
  setInvalidationPublisher,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
  notifyDocUpdate,
  notifyAgentRunEvent,
  notifyInboxCardsInvalidation,
  notifyInvalidation,
  notifyNotificationCreated,
  notifySessionRevoked,
} from "@semprec/data";
import { createChokePoint, createDocStore, createPool, withTransaction } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { wireRealtimeHooks } from "../wireHooks.js";
import { publishRealtimeMessage } from "../pgNotifyPublisher.js";
import { createSyncServer } from "../syncServer.js";

let pool: Pool;

// wireRealtimeHooks(pool) installs every hook, not just the one a given test exercises. Reset
// all of them so a test that only unsets its own hook can never leave the rest wired to `pool`
// for a later test in this file to trip over.
function resetHooks(): void {
  setInvalidationHook(() => {});
  setInvalidationPublisher(async () => {});
  setDocUpdateHook(() => {});
  setNotificationCreatedHook(() => {});
  setNotificationReadStateHook(() => {});
  setSessionRevokedHook(() => {});
  setAgentRunEventHook(() => {});
  setInboxCardsInvalidationHook(() => {});
}

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

describe("realtime", () => {
  beforeEach(async () => {
    // The shared embedded-Postgres instance (vitest globalSetup, packages/data) already has
    // migrations applied, but other files leave rows behind in it. Every envelope assertion here
    // depends on that state — `app_tenant_default()` resolves tenant zero only while it is the sole
    // `tenants` row, and `users.tenant_id` is unique — so reset it before each test.
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    resetHooks();
    await pool?.end();
  });

  it("delivers a document write to an unsubscribed tenant socket and never to another tenant", async () => {
    const owner = getTenantZeroId();
    const foreign = await createTestTenant(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const api = createChokePoint(runtime);
    const docs = createDocStore(runtime);
    const fixture = await runInTenant(owner, async () => {
      const database = await api.createDatabase({ name: "Pages" });
      const item = await api.createItem({ databaseId: database.id, properties: {} });
      await docs.putBlock(item.id, { id: "root", flavour: "page" }, "user");
      const doc = await docs.getDoc(item.id);
      if (!doc) throw new Error("Document fixture was not created");
      return { database, item, doc };
    });
    wireRealtimeHooks(runtime);
    const server = await createSyncServer(runtime, {
      authenticate: async (request) => ({
        tenantId: request.url === "/owner" ? owner : foreign,
        userId: randomUUID(),
        sessionId: randomUUID(),
      }),
      revalidateSession: async () => true,
    });
    const http = createServer();
    http.on("upgrade", (request, socket, head) => server.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const ownerSocket = new WebSocket(`ws://127.0.0.1:${address.port}/owner`);
    const foreignSocket = new WebSocket(`ws://127.0.0.1:${address.port}/foreign`);
    const open = (socket: WebSocket) =>
      new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    try {
      await Promise.all([open(ownerSocket), open(foreignSocket)]);
      const ownerFrames: unknown[] = [];
      const foreignFrames: unknown[] = [];
      ownerSocket.on("message", (data) => ownerFrames.push(JSON.parse(frameText(data))));
      foreignSocket.on("message", (data) => foreignFrames.push(JSON.parse(frameText(data))));
      await runInTenant(owner, () => docs.putBlock(fixture.item.id, { id: "next", flavour: "page" }, "user"));
      await vi.waitFor(() => expect(ownerFrames).toHaveLength(1));
      const updated = await runInTenant(owner, () => docs.getDoc(fixture.item.id));
      expect(ownerFrames).toEqual([
        {
          type: "invalidate",
          scope: "doc",
          docId: fixture.doc.id,
          itemId: fixture.item.id,
          databaseId: fixture.database.id,
          lastEditedAt: updated?.lastEditedAt,
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(foreignFrames).toEqual([]);
      await runInTenant(owner, () =>
        publishRealtimeMessage(runtime, {
          type: "doc_update",
          docId: randomUUID(),
          updateId: "1",
          createdBy: "user",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ownerFrames).toHaveLength(1);
      expect(foreignFrames).toEqual([]);

      // Let the first leading window settle before observing a separate burst of real writes.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      ownerFrames.length = 0;
      const listener = await pool.connect();
      const arrivals: number[] = [];
      try {
        await listener.query("LISTEN semprec_events");
        listener.on("notification", (notification) => {
          if (!notification.payload) return;
          const value: unknown = JSON.parse(notification.payload);
          if (typeof value !== "object" || value === null || !("tenantId" in value) || !("message" in value)) return;
          const message = value.message;
          if (
            value.tenantId === owner &&
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "doc_update" &&
            "docId" in message &&
            message.docId === fixture.doc.id
          )
            arrivals.push(performance.now());
        });
        const started = performance.now();
        await runInTenant(owner, () =>
          docs.putBlock(fixture.item.id, { id: "burst-leading", flavour: "page" }, "user"),
        );
        await vi.waitFor(() => expect(ownerFrames).toHaveLength(1));
        await runInTenant(owner, () =>
          Promise.all(
            Array.from({ length: 99 }, (_, index) =>
              docs.putBlock(fixture.item.id, { id: `burst-${index}`, flavour: "page" }, "user"),
            ),
          ),
        );
        expect(performance.now() - started).toBeLessThan(1000);
        await vi.waitFor(() => expect(arrivals).toHaveLength(100));
        expect(arrivals[99]! - arrivals[0]!).toBeLessThan(1000);
        const lastWrite = await runInTenant(owner, () => docs.getDoc(fixture.item.id));
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(ownerFrames).toHaveLength(2);
        expect(ownerFrames.at(-1)).toMatchObject({
          type: "invalidate",
          scope: "doc",
          docId: fixture.doc.id,
          lastEditedAt: lastWrite?.lastEditedAt,
        });
        expect(foreignFrames).toEqual([]);
      } finally {
        // Destroy this dedicated LISTEN client so its subscription cannot leak into the pool.
        listener.release(new Error("test listener complete"));
      }

      // The older transaction starts first but writes after the newer one commits.
      ownerFrames.length = 0;
      let unblock!: () => void;
      let startedEarlier!: () => void;
      const blocked = new Promise<void>((resolve) => (unblock = resolve));
      const earlierStarted = new Promise<void>((resolve) => (startedEarlier = resolve));
      let checkouts = 0;
      const heldPool = new Proxy(runtime, {
        get(target, property, receiver) {
          if (property !== "connect") {
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const client = await target.connect();
            const checkout = ++checkouts;
            return new Proxy(client, {
              get(clientTarget, key, clientReceiver) {
                if (key !== "query") {
                  const value: unknown = Reflect.get(clientTarget, key, clientReceiver);
                  return typeof value === "function" ? value.bind(clientTarget) : value;
                }
                return async (...args: unknown[]) => {
                  const result: unknown = await Reflect.apply(
                    clientTarget.query.bind(clientTarget),
                    clientTarget,
                    args,
                  );
                  if (checkout === 2 && args[0] === "BEGIN") {
                    startedEarlier();
                    await blocked;
                  }
                  return result;
                };
              },
            });
          };
        },
      });
      const heldDocs = createDocStore(heldPool);
      const earlierWrite = runInTenant(owner, () =>
        heldDocs.putBlock(fixture.item.id, { id: "earlier-transaction", flavour: "page" }, "user"),
      );
      try {
        await earlierStarted;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await runInTenant(owner, () =>
          docs.putBlock(fixture.item.id, { id: "later-transaction", flavour: "page" }, "user"),
        );
        const later = await runInTenant(owner, () => docs.getDoc(fixture.item.id));
        await vi.waitFor(() => expect(ownerFrames.length).toBeGreaterThan(0));
        unblock();
        await earlierWrite;
        const final = await runInTenant(owner, () => docs.getDoc(fixture.item.id));
        expect(final!.lastEditedAt < later!.lastEditedAt).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(ownerFrames.at(-1)).toMatchObject({ lastEditedAt: final!.lastEditedAt });
        expect(foreignFrames).toEqual([]);
      } finally {
        unblock();
        await earlierWrite;
      }
    } finally {
      ownerSocket.close();
      foreignSocket.close();
      await server.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      resetHooks();
      await runtime.end();
    }
  });

  it("bounds relation notifications while retaining the PostgreSQL tenant envelope and user restriction", async () => {
    const tenant = await createTestTenant(pool);
    const scoped = await createRuntimeRolePool(pool, "semprec_data");
    const listener = await pool.connect();
    const base = {
      type: "invalidation",
      scope: "relation",
      databaseId: randomUUID(),
      itemId: randomUUID(),
      propertyKey: "",
      op: "metadata",
      userId: randomUUID(),
    } as const;
    const remaining = 7000 - Buffer.byteLength(JSON.stringify(base), "utf8");
    try {
      const role = await runAsSystem("test:verify-runtime-role", () =>
        scoped.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
      await listener.query("LISTEN semprec_events");
      for (const key of ["normal", "a".repeat(remaining), "a".repeat(remaining + 1), 'ě\\"'.repeat(4000)]) {
        const received = new Promise<{ payload?: string }>((resolve) => listener.once("notification", resolve));
        await runInTenant(tenant, () => publishRealtimeMessage(scoped, { ...base, propertyKey: key }));
        const payload = (await received).payload;
        if (payload === undefined) throw new Error("Expected notification payload");
        expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(8000);
        const expectedKey =
          Buffer.byteLength(JSON.stringify({ ...base, propertyKey: key }), "utf8") <= 7000 ? key : null;
        expect(JSON.parse(payload)).toEqual({ tenantId: tenant, message: { ...base, propertyKey: expectedKey } });
      }
    } finally {
      listener.release(true);
      await scoped.end();
    }
  });

  it("wireRealtimeHooks turns an item-scope invalidation event into a Postgres NOTIFY on the shared channel (issue #161)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listenClient.once("notification", resolve);
      });

      notifyInvalidation({
        scope: "item",
        databaseId: "db-1",
        itemId: "item-1",
        op: "update",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        tenantId: getTenantZeroId(),
        message: {
          type: "invalidation",
          scope: "item",
          databaseId: "db-1",
          itemId: "item-1",
          op: "update",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    } finally {
      listenClient.release(true);
      setInvalidationHook(() => {});
    }
  });

  it("wireRealtimeHooks turns a schema-scope invalidation event into a Postgres NOTIFY on the shared channel (issue #161)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listenClient.once("notification", resolve);
      });

      notifyInvalidation({ scope: "schema", databaseId: "db-1" });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        tenantId: getTenantZeroId(),
        message: {
          type: "invalidation",
          scope: "schema",
          databaseId: "db-1",
        },
      });
    } finally {
      listenClient.release(true);
      setInvalidationHook(() => {});
    }
  });

  it("wireRealtimeHooks turns a mail-thread event into a thin Postgres NOTIFY, carrying the user only when the event names one (issue #1816)", async () => {
    wireRealtimeHooks(pool);
    const threadId = randomUUID();
    const userId = randomUUID();

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received: Array<{ channel: string; payload?: string }> = [];
      listenClient.on("notification", (notification) => received.push(notification));

      notifyInvalidation({ scope: "mailThread", threadId });
      notifyInvalidation({ scope: "mailThread", threadId, userId });
      await vi.waitFor(() => expect(received).toHaveLength(2));

      // The two NOTIFY statements run on separate pooled connections, so their arrival order is not
      // fixed; the payload without a user id is put first before the payloads are compared.
      const payloads = received
        .map((notification) => notification.payload ?? "{}")
        .sort((left, right) => Number(left.includes('"userId"')) - Number(right.includes('"userId"')));
      expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
        { tenantId: getTenantZeroId(), message: { type: "invalidation", scope: "mailThread", threadId } },
        { tenantId: getTenantZeroId(), message: { type: "invalidation", scope: "mailThread", threadId, userId } },
      ]);
    } finally {
      listenClient.release(true);
      setInvalidationHook(() => {});
    }
  });

  it("wireRealtimeHooks turns an inbox-cards event into a thin Postgres NOTIFY on the shared channel (issue #1811)", async () => {
    wireRealtimeHooks(pool);
    const cardId = randomUUID();
    const userId = randomUUID();

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received: Array<{ channel: string; payload?: string }> = [];
      listenClient.on("notification", (notification) => received.push(notification));

      notifyInboxCardsInvalidation({ op: "closed", cardId });
      notifyInboxCardsInvalidation({ op: "created", cardId, userId });
      await vi.waitFor(() => expect(received).toHaveLength(2));

      // Only the card and the operation travel: no proposal, status or history of the card. The two
      // NOTIFY statements run on separate pooled connections, so the "closed" payload is put first
      // before the payloads are compared.
      const payloads = received
        .map((notification) => notification.payload ?? "{}")
        .sort((left, right) => Number(right.includes('"op":"closed"')) - Number(left.includes('"op":"closed"')));
      expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
        {
          tenantId: getTenantZeroId(),
          message: { type: "invalidation", scope: "inboxCards", op: "closed", cardId },
        },
        {
          tenantId: getTenantZeroId(),
          message: { type: "invalidation", scope: "inboxCards", op: "created", cardId, userId },
        },
      ]);
    } finally {
      listenClient.release(true);
      setInboxCardsInvalidationHook(() => {});
    }
  });

  it("does not throw out of an inbox-cards event when its NOTIFY fails (issue #1811)", async () => {
    const unusable = createPool(process.env.TEST_DATABASE_URL ?? "");
    await unusable.end();
    wireRealtimeHooks(unusable);
    try {
      expect(() => notifyInboxCardsInvalidation({ op: "updated", cardId: randomUUID() })).not.toThrow();
      // The rejected publish is handled by the hook; an unhandled rejection would fail this file.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      resetHooks();
    }
  });

  it("wireRealtimeHooks turns a doc-update event into a thin Postgres NOTIFY on the shared channel (issue #161)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listenClient.once("notification", resolve);
      });

      notifyDocUpdate({ docId: "doc-1", updateId: "update-1", createdBy: "ai_agent" });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        tenantId: getTenantZeroId(),
        message: {
          type: "doc_update",
          docId: "doc-1",
          updateId: "update-1",
          createdBy: "ai_agent",
        },
      });
    } finally {
      listenClient.release(true);
      setDocUpdateHook(() => {});
    }
  });

  it("wireRealtimeHooks turns a notification-created event into a thin, user-scoped Postgres NOTIFY (issue #161)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listenClient.once("notification", resolve);
      });

      notifyNotificationCreated({ userId: "user-1", notificationId: "notif-1" });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        tenantId: getTenantZeroId(),
        message: {
          type: "notification_created",
          userId: "user-1",
          notificationId: "notif-1",
        },
      });
    } finally {
      listenClient.release(true);
      setNotificationCreatedHook(() => {});
      setNotificationReadStateHook(() => {});
    }
  });

  it("wireRealtimeHooks turns a session-revoked event into a Postgres NOTIFY on the shared channel (issue #160)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listenClient.once("notification", resolve);
      });

      const sessionId = await createSessionForUser(pool, getTenantZeroId());
      notifySessionRevoked({ sessionId });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        tenantId: getTenantZeroId(),
        message: {
          type: "session_revoked",
          sessionId,
        },
      });
    } finally {
      listenClient.release(true);
      setSessionRevokedHook(() => {});
    }
  });

  it("wireRealtimeHooks turns a durable agent-run reference into a thin Postgres NOTIFY (issue #163)", async () => {
    wireRealtimeHooks(pool);

    const listenClient = await pool.connect();
    try {
      await listenClient.query("LISTEN semprec_events");
      const received = new Promise<{ channel: string; payload?: string }>((resolve) => {
        listenClient.once("notification", resolve);
      });

      notifyAgentRunEvent({
        agentRunId: "11111111-1111-1111-1111-111111111111",
        eventId: "42",
      });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        tenantId: getTenantZeroId(),
        message: {
          type: "agent_run_event",
          agentRunId: "11111111-1111-1111-1111-111111111111",
          eventId: "42",
        },
      });
    } finally {
      listenClient.release(true);
      resetHooks();
    }
  });

  describe("tenant envelope (issue #1025)", () => {
    let scopedPool: Pool;

    beforeEach(() => {
      resetHooks();
      scopedPool = createPool(process.env.TEST_DATABASE_URL ?? "");
    });

    afterEach(async () => {
      await scopedPool.end();
    });

    async function listen(client: PoolClient): Promise<() => Promise<unknown>> {
      await client.query("LISTEN semprec_events");
      const received = new Promise<{ payload?: string }>((resolve) => client.once("notification", resolve));
      return async () => JSON.parse((await received).payload ?? "{}");
    }

    it("stamps the publisher's tenant on the envelope and ignores a tenantId inside the message body", async () => {
      const tenantId = await createTestTenant(pool);
      const bodyTenant = await createTestTenant(pool);
      wireRealtimeHooks(scopedPool);
      const listenClient = await pool.connect();
      try {
        const payload = await listen(listenClient);
        runInTenant(tenantId, () => {
          notifyInvalidation({ scope: "schema", databaseId: "db-1", tenantId: bodyTenant } as never);
        });
        const envelope = (await payload()) as { tenantId: string; message: Record<string, unknown> };
        expect(envelope.tenantId).toBe(tenantId);
        expect(envelope.message).toMatchObject({ type: "invalidation", scope: "schema", databaseId: "db-1" });
      } finally {
        listenClient.release(true);
      }
    });

    it("stamps the publisher's tenant on an inbox-cards event and ignores a tenantId inside the event (issue #1811)", async () => {
      const tenantId = await createTestTenant(pool);
      const bodyTenant = await createTestTenant(pool);
      const cardId = randomUUID();
      wireRealtimeHooks(scopedPool);
      const listenClient = await pool.connect();
      try {
        const payload = await listen(listenClient);
        runInTenant(tenantId, () => {
          notifyInboxCardsInvalidation({ op: "created", cardId, tenantId: bodyTenant } as never);
        });
        const envelope = (await payload()) as { tenantId: string; message: Record<string, unknown> };
        expect(envelope.tenantId).toBe(tenantId);
        expect(envelope.message).toMatchObject({ type: "invalidation", scope: "inboxCards", op: "created", cardId });
      } finally {
        listenClient.release(true);
      }
    });

    // Strict `app_tenant_default()` (#1067) no longer falls back to the sole tenant.
    it("stamps no tenant when a hook fires with no scope, even while tenant zero is the only tenant", async () => {
      wireRealtimeHooks(scopedPool);
      const listenClient = await pool.connect();
      try {
        const payload = await listen(listenClient);
        notifyInvalidation({ scope: "schema", databaseId: "db-1" });
        expect(await payload()).toEqual({
          tenantId: null,
          message: { type: "invalidation", scope: "schema", databaseId: "db-1" },
        });
      } finally {
        listenClient.release(true);
      }
    });

    it("stamps a session_revoked published inside runAsSystem with the session user's tenant", async () => {
      const tenantId = await createTestTenant(pool);
      const sessionId = await createSessionForUser(pool, tenantId);
      const listenClient = await pool.connect();
      try {
        const payload = await listen(listenClient);
        await runAsSystem("test:revoke", () =>
          publishRealtimeMessage(scopedPool, { type: "session_revoked", sessionId }),
        );
        expect(await payload()).toEqual({ tenantId, message: { type: "session_revoked", sessionId } });
      } finally {
        listenClient.release(true);
      }
    });
  });
});

/** Inserts a user bound to `tenantId` and one session for it; returns the session id. */
async function createSessionForUser(adminPool: Pool, tenantId: string): Promise<string> {
  return withTransaction(adminPool, async (client) => {
    const user = await client.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, tenant_id) VALUES ($1, 'unused', $2) RETURNING id",
      [`${randomUUID()}@example.test`, tenantId],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("user insert returned no row");
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, platform, expires_at)
       VALUES ($1, $2, 'web', now() + interval '1 day') RETURNING id`,
      [userId, randomUUID()],
    );
    const sessionId = session.rows[0]?.id;
    if (!sessionId) throw new Error("session insert returned no row");
    return sessionId;
  });
}
