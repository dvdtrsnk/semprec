import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  setDocUpdateHook,
  setAgentRunEventHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
  notifyDocUpdate,
  notifyAgentRunEvent,
  notifyInvalidation,
  notifyNotificationCreated,
  notifySessionRevoked,
} from "@semprec/data";
import { createPool, withTransaction } from "@semprec/data";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { wireRealtimeHooks } from "../wireHooks.js";
import { publishRealtimeMessage } from "../pgNotifyPublisher.js";

let pool: Pool;

// wireRealtimeHooks(pool) installs every hook, not just the one a given test exercises. Reset
// all of them so a test that only unsets its own hook can never leave the rest wired to `pool`
// for a later test in this file to trip over.
function resetHooks(): void {
  setInvalidationHook(() => {});
  setDocUpdateHook(() => {});
  setNotificationCreatedHook(() => {});
  setNotificationReadStateHook(() => {});
  setSessionRevokedHook(() => {});
  setAgentRunEventHook(() => {});
}

describe("realtime", () => {
  beforeEach(() => {
    // The shared embedded-Postgres instance (vitest globalSetup, packages/data) already
    // has migrations applied; these tests only exercise LISTEN/NOTIFY, not any of the
    // data package's own tables, so a plain Pool is enough — no need to reach into
    // @semprec/data's internal testSupport helpers for a table-truncating reset.
    pool ??= getTestPool();
  });

  afterAll(async () => {
    resetHooks();
    await pool?.end();
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

    beforeEach(async () => {
      resetHooks();
      await resetDatabase(pool);
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

    it("falls back to the sole tenant when a hook fires with no scope", async () => {
      wireRealtimeHooks(scopedPool);
      const listenClient = await pool.connect();
      try {
        const payload = await listen(listenClient);
        notifyInvalidation({ scope: "schema", databaseId: "db-1" });
        expect(await payload()).toEqual({
          tenantId: getTenantZeroId(),
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
