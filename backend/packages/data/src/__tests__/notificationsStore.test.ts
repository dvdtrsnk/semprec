import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { writeNotification } from "../notifications/notify.js";
import {
  listUnreadNotificationsForUser,
  visitNotification,
  markAllNotificationsRead,
} from "../notifications/notificationsStore.js";
import { setNotificationReadStateHook, type NotificationReadStateEvent } from "../realtimeHook.js";

let pool: Pool;

describe("notificationsStore (issue #152)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(() => {
    setNotificationReadStateHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTestUser(): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, { email: `${Math.random()}@example.test`, passwordHash });
    return user.id;
  }

  async function writeTestNotification(userId: string, sourceId: string, linkHref: string | null = null) {
    await withTransaction(pool, (client) =>
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
});
