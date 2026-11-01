import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { randomUUID } from "node:crypto";
import { inTenantZero } from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createPendingApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { decideAndEnqueueApprovalRequest } from "../mcp/approvalDecisionAction.js";
import { writeNotification } from "../notifications/notify.js";
import {
  listUnreadNotificationsForUser,
  visitNotification,
  markAllNotificationsRead,
  resolveNotificationsBySource,
  getNotificationById,
} from "../notifications/notificationsStore.js";
import { setNotificationReadStateHook, type NotificationReadStateEvent } from "../realtimeHook.js";

let pool: Pool;

describe("notificationsStore (issue #152)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantOfUser.clear();
  });

  afterEach(() => {
    setNotificationReadStateHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** The tenant each test user is bound to: a notification may only name its own tenant's user (issue #1066). */
  const tenantOfUser = new Map<string, string>();

  /** The first user is tenant zero's; each later one gets a tenant of its own, as a tenant has one user. */
  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const tenantId = tenantOfUser.size === 0 ? getTenantZeroId() : await createTestTenant(pool);
    const user = await createUser(pool, { email: `${Math.random()}@example.test`, passwordHash, tenantId });
    tenantOfUser.set(user.id, tenantId);
    return user.id;
  }

  async function writeTestNotification(userId: string, sourceId: string, linkHref: string | null = null) {
    const tenantId = tenantOfUser.get(userId);
    if (!tenantId) throw new Error(`writeTestNotification: ${userId} was not created by createTestUser`);
    await withTenantTransaction(pool, tenantId, (client) =>
      writeNotification(client, {
        userId,
        kind: "heartbeat_error",
        titleParams: { name: sourceId },
        linkHref,
        sourceTable: "project_heartbeats",
        sourceId,
        transitionInstance: "job-1",
      }),
    );
  }

  describe("listUnreadNotificationsForUser", () => {
    it.each([null, [], "invalid", 1])("refuses a malformed stored payload %j", async (payload) => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "payload-test");
      const [row] = await listUnreadNotificationsForUser(pool, userId);
      if (!row) throw new Error("Missing notification fixture");
      // JSONB historically permits non-object values, which production writers do not create.
      await pool.query("UPDATE notifications SET payload = $2::jsonb WHERE id = $1", [row.id, JSON.stringify(payload)]);
      await expect(getNotificationById(pool, row.id)).rejects.toThrow("Invalid notification payload");
      await expect(listUnreadNotificationsForUser(pool, userId)).rejects.toThrow("Invalid notification payload");
    });
    it("returns only the caller's unread rows, ordered by creation then id", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();

      await writeTestNotification(userId, "hb-1");
      await writeTestNotification(userId, "hb-2");
      await writeTestNotification(otherUserId, "hb-other");

      const unread = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(unread.map((n) => n.sourceId)).toEqual(["hb-1", "hb-2"]);
    });

    it("excludes a notification once it has been read", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [before] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      await withTransaction(pool, (client) => visitNotification(client, userId, before!.id));

      const after = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(after).toHaveLength(0);
    });
  });

  describe("visitNotification", () => {
    it("marks an unread notification read and returns it", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1", "?page=heartbeats");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const visited = await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      expect(visited?.readAt).not.toBeNull();
      expect(visited?.linkHref).toBe("?page=heartbeats");
    });

    it("is idempotent: a repeat visit returns the same target without changing readAt", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const first = await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      const second = await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      expect(second?.readAt).toBe(first?.readAt);
    });

    it("returns null for an unknown notification id", async () => {
      const userId = await createTestUser();
      const result = await withTransaction(pool, (client) =>
        visitNotification(client, userId, "00000000-0000-0000-0000-000000000000"),
      );
      expect(result).toBeNull();
    });

    it("returns null when the notification belongs to a different user", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const result = await withTransaction(pool, (client) => visitNotification(client, otherUserId, unread!.id));
      expect(result).toBeNull();

      // The other user's mistaken attempt must not have marked it read.
      const stillUnread = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      expect(stillUnread).toHaveLength(1);
    });

    it("fires the read-state realtime hook only on the transition, not on a repeat visit", async () => {
      const userId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      const [unread] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));

      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));
      await withTransaction(pool, (client) => visitNotification(client, userId, unread!.id));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ userId, notificationIds: [unread!.id] });
    });
  });

  describe("markAllNotificationsRead", () => {
    it("marks every unread notification for the user read and fires one realtime event", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      await writeTestNotification(userId, "hb-2");
      await writeTestNotification(otherUserId, "hb-other");

      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const updated = await withTransaction(pool, (client) => markAllNotificationsRead(client, userId));
      expect(updated).toHaveLength(2);
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(userId);
      expect(new Set(events[0]!.notificationIds)).toEqual(new Set(updated.map((n) => n.id)));

      const otherUnread = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, otherUserId));
      expect(otherUnread).toHaveLength(1);
    });

    it("fires no realtime event and returns an empty list when there is nothing unread", async () => {
      const userId = await createTestUser();
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const updated = await withTransaction(pool, (client) => markAllNotificationsRead(client, userId));
      expect(updated).toEqual([]);
      expect(events).toHaveLength(0);
    });
  });

  describe("approval decisions resolve their notification (issue #1463)", () => {
    async function createApprovalWithNotification(userId: string) {
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        task: "test",
        projectItemId: randomUUID(),
        userId,
      });
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "search_web",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      });
      await withTenantTransaction(pool, tenantOfUser.get(userId)!, (client) =>
        writeNotification(client, {
          userId,
          kind: "approval_pending",
          titleParams: { name: "search_web" },
          linkHref: null,
          sourceTable: "approval_requests",
          sourceId: request.id,
          transitionInstance: "pending",
        }),
      );
      return request;
    }

    async function stateOf(sourceId: string) {
      const { rows } = await pool.query<{ read_at: Date | null; resolved_at: Date | null }>(
        "SELECT read_at, resolved_at FROM notifications WHERE source_id = $1",
        [sourceId],
      );
      return rows;
    }

    function decide(userId: string, approvalRequestId: string, fail = false) {
      return inTenantZero(() =>
        withTransaction(pool, async (client) => {
          const result = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId,
            decision: "rejected",
            decidedByUserId: userId,
          });
          if (fail) throw new Error("rollback");
          return result;
        }),
      );
    }

    it("resolves and reads the notification and publishes one read-state event", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const result = await decide(userId, request.id);

      expect(result!.outcome).toBe("decided");
      const [row] = await stateOf(request.id);
      expect(row!.resolved_at).not.toBeNull();
      expect(row!.read_at).not.toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(userId);
      expect(events[0]!.notificationIds).toHaveLength(1);
    });

    it("changes nothing and sends no event when the decision is replayed", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      await decide(userId, request.id);
      const before = await stateOf(request.id);
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const replay = await decide(userId, request.id);

      expect(replay!.outcome).toBe("unchanged");
      expect(await stateOf(request.id)).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it("leaves the notification unresolved when the decision transaction rolls back", async () => {
      const userId = await createTestUser();
      const request = await createApprovalWithNotification(userId);
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      await expect(decide(userId, request.id, true)).rejects.toThrow("rollback");

      expect(await stateOf(request.id)).toEqual([{ read_at: null, resolved_at: null }]);
      expect(events).toHaveLength(0);
    });

    it("resolves only the named source, across users, and keeps an already read row's readAt", async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      await writeTestNotification(userId, "hb-1");
      await writeTestNotification(otherUserId, "hb-1");
      await writeTestNotification(userId, "hb-2");
      const [first] = await withTransaction(pool, (client) => listUnreadNotificationsForUser(client, userId));
      await withTransaction(pool, (client) => visitNotification(client, userId, first!.id));
      const readAt = (await stateOf("hb-1")).find((row) => row.read_at)!.read_at;
      const events: NotificationReadStateEvent[] = [];
      setNotificationReadStateHook((event) => events.push(event));

      const resolved = await withTransaction(pool, (client) =>
        resolveNotificationsBySource(client, { sourceTable: "project_heartbeats", sourceId: "hb-1" }),
      );

      expect(resolved).toHaveLength(2);
      expect((await stateOf("hb-1")).every((row) => row.resolved_at && row.read_at)).toBe(true);
      expect((await stateOf("hb-1")).some((row) => row.read_at!.getTime() === readAt!.getTime())).toBe(true);
      expect(await stateOf("hb-2")).toEqual([{ read_at: null, resolved_at: null }]);
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(otherUserId);
    });
  });
});
