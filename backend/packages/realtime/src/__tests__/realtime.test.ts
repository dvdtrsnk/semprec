import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
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
import { wireRealtimeHooks } from "../wireHooks.js";

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
    pool ??= new Pool({ connectionString: process.env.TEST_DATABASE_URL });
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
        type: "invalidation",
        scope: "item",
        databaseId: "db-1",
        itemId: "item-1",
        op: "update",
        updatedAt: "2026-01-01T00:00:00.000Z",
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
        type: "invalidation",
        scope: "schema",
        databaseId: "db-1",
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
        type: "doc_update",
        docId: "doc-1",
        updateId: "update-1",
        createdBy: "ai_agent",
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
        type: "notification_created",
        userId: "user-1",
        notificationId: "notif-1",
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

      notifySessionRevoked({ sessionId: "session-1" });

      const notification = await received;
      expect(JSON.parse(notification.payload ?? "{}")).toEqual({
        type: "session_revoked",
        sessionId: "session-1",
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
        type: "agent_run_event",
        agentRunId: "11111111-1111-1111-1111-111111111111",
        eventId: "42",
      });
    } finally {
      listenClient.release(true);
      resetHooks();
    }
  });
});
