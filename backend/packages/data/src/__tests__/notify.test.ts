import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { writeNotification } from "../notifications/notify.js";
import { setNotificationCreatedHook, type NotificationCreatedEvent } from "../realtimeHook.js";

let pool: Pool;

describe("writeNotification", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(() => {
    setNotificationCreatedHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createTestUser(locale = "en"): Promise<string> {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, { email: `${locale}-${Math.random()}@example.test`, passwordHash, locale });
    return user.id;
  }

  it("inserts a localized title bound to the user and source", async () => {
    const userId = await createTestUser("en");
    await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-1",
        transitionInstance: "job-1",
      }),
    );

    const { rows } = await pool.query(
      `SELECT user_id, title, source_table, source_id, read_at FROM notifications WHERE source_id = $1`,
      ["hb-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].title).toBe(`Heartbeat "Daily digest" failed`);
    expect(rows[0].source_table).toBe("project_heartbeats");
    expect(rows[0].read_at).toBeNull();
  });

  it("localizes the title through users.locale", async () => {
    const userId = await createTestUser("cs");
    await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: null,
        sourceTable: "project_heartbeats",
        sourceId: "hb-cs",
        transitionInstance: "job-1",
      }),
    );

    const { rows } = await pool.query(`SELECT title FROM notifications WHERE source_id = $1`, ["hb-cs"]);
    expect(rows[0].title).toBe(`Heartbeat „Daily digest“ selhal`);
  });

  it("rolls back the notification when the caller's transaction rolls back", async () => {
    const userId = await createTestUser();
    await expect(
      withTransaction(pool, async (client) => {
        await writeNotification(client, {
          userId,
          kind: "heartbeat_error",
          titleParams: { name: "Doomed" },
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "hb-rollback",
          transitionInstance: "job-1",
        });
        throw new Error("caller transaction fails after the write");
      }),
    ).rejects.toThrow("caller transaction fails after the write");

    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, ["hb-rollback"]);
    expect(rows).toHaveLength(0);
  });

  it("does not duplicate a row when the same transition replays, but a new transition on the same source still inserts", async () => {
    const userId = await createTestUser();
    const write = (transitionInstance: string) =>
      withTransaction(pool, (client) =>
        writeNotification(client, {
          userId,
          kind: "heartbeat_error",
          titleParams: { name: "Replayed" },
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "hb-replay",
          transitionInstance,
        }),
      );

    await write("job-1");
    await write("job-1"); // replay of the same transition: must not duplicate
    const { rows: afterReplay } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, ["hb-replay"]);
    expect(afterReplay).toHaveLength(1);

    await write("job-2"); // a distinct, later failure of the same source: a genuinely new row
    const { rows: afterNewTransition } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [
      "hb-replay",
    ]);
    expect(afterNewTransition).toHaveLength(2);
  });

  it("rejects a kind outside the closed catalog at the database level", async () => {
    const userId = await createTestUser();
    await expect(
      pool.query(
        `INSERT INTO notifications (user_id, kind, title, source_table, source_id, transition_instance)
         VALUES ($1, 'not_a_real_kind', 'x', 'project_heartbeats', 'hb-1', 'job-1')`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it("fires the notification_created realtime hook after commit, but not for a replayed transition", async () => {
    const userId = await createTestUser();
    const events: NotificationCreatedEvent[] = [];
    setNotificationCreatedHook((event) => events.push(event));

    await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: "?page=heartbeats",
        sourceTable: "project_heartbeats",
        sourceId: "hb-realtime",
        transitionInstance: "job-1",
      }),
    );
    // Replaying the same transition must not fire a second event.
    await withTransaction(pool, (client) =>
      writeNotification(client, {
        userId,
        kind: "heartbeat_error",
        titleParams: { name: "Daily digest" },
        linkHref: "?page=heartbeats",
        sourceTable: "project_heartbeats",
        sourceId: "hb-realtime",
        transitionInstance: "job-1",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId, notificationId: expect.any(String) });
  });

  it("never fires the realtime hook when the caller's transaction rolls back", async () => {
    const userId = await createTestUser();
    const events: NotificationCreatedEvent[] = [];
    setNotificationCreatedHook((event) => events.push(event));

    await expect(
      withTransaction(pool, async (client) => {
        await writeNotification(client, {
          userId,
          kind: "heartbeat_error",
          titleParams: { name: "Doomed" },
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: "hb-rollback-realtime",
          transitionInstance: "job-1",
        });
        throw new Error("caller transaction fails after the write");
      }),
    ).rejects.toThrow("caller transaction fails after the write");

    expect(events).toHaveLength(0);
  });

  it("has a partial index on user_id where read_at is null, backing the unread lookup", async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'notifications' AND indexname = 'notifications_unread_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("read_at IS NULL");
    expect(rows[0].indexdef).toContain("user_id");
  });
});
