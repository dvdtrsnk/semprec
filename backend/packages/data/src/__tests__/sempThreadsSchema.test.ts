import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createAgentRun, finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { handleAgentRunEventsRetentionTask } from "../agentRuns/agentRunEventsRetention.js";
import { orderTablesForPurge } from "../tenancy/tenantPurgeOrder.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let adminPool: Pool;
let runtimePool: Pool;

async function insertHeartbeat(): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO project_heartbeats (project_item_id, name, rule, action_id)
     VALUES ($1, 'hb', '{"kind":"dailyTime","at":"09:00"}'::jsonb, 'noop') RETURNING id`,
    [randomUUID()],
  );
  return rows[0]!.id;
}

async function insertThread(
  kind: "chat" | "item" | "tick",
  columns: { subjectInboxItemId?: string | null; heartbeatId?: string | null; title?: string | null } = {},
  pool: Pool = adminPool,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO semp_threads (kind, subject_inbox_item_id, heartbeat_id, title)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [kind, columns.subjectInboxItemId ?? null, columns.heartbeatId ?? null, columns.title ?? null],
  );
  return rows[0]!.id;
}

async function insertMessage(threadId: string, role = "user", extra: { agentRunId?: string } = {}): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO semp_messages (thread_id, role, text, agent_run_id) VALUES ($1, $2, 'hello', $3) RETURNING id`,
    [threadId, role, extra.agentRunId ?? null],
  );
  return rows[0]!.id;
}

describe("semp_threads and semp_messages schema (issue #1367)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await createTenantZeroUser(adminPool);
  });

  describe("row-level security", () => {
    it("hides tenant B's threads and messages from tenant A and refuses writes into them", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(adminPool);
      const threadB = await withTenantTransaction(runtimePool, tenantB, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id",
        );
        const id = rows[0]!.id;
        await client.query("INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'b')", [id]);
        return id;
      });

      await withTenantTransaction(runtimePool, tenantA, async (client) => {
        expect((await client.query("SELECT id FROM semp_threads")).rowCount).toBe(0);
        expect((await client.query("SELECT id FROM semp_messages")).rowCount).toBe(0);
        // Updates and deletes see no rows.
        expect((await client.query("UPDATE semp_threads SET title = 'x' WHERE id = $1", [threadB])).rowCount).toBe(0);
        expect((await client.query("DELETE FROM semp_messages WHERE thread_id = $1", [threadB])).rowCount).toBe(0);
        expect((await client.query("DELETE FROM semp_threads WHERE id = $1", [threadB])).rowCount).toBe(0);
      });

      await withTenantTransaction(runtimePool, tenantA, async (client) => {
        await expect(
          client.query("INSERT INTO semp_threads (tenant_id, kind) VALUES ($1, 'chat')", [tenantB]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await withTenantTransaction(runtimePool, tenantA, async (client) => {
        await expect(
          client.query("INSERT INTO semp_messages (tenant_id, thread_id, role) VALUES ($1, $2, 'user')", [
            tenantB,
            threadB,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      });

      await withTenantTransaction(runtimePool, tenantB, async (client) => {
        expect((await client.query("SELECT id FROM semp_threads")).rowCount).toBe(1);
        expect((await client.query("SELECT id FROM semp_messages")).rowCount).toBe(1);
      });
    });

    it("refuses a message in tenant A that points at tenant B's thread", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(adminPool);
      const threadB = await withTenantTransaction(runtimePool, tenantB, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id",
        );
        return rows[0]!.id;
      });
      await withTenantTransaction(runtimePool, tenantA, async (client) => {
        await expect(
          client.query("INSERT INTO semp_messages (thread_id, role) VALUES ($1, 'user')", [threadB]),
        ).rejects.toMatchObject({ code: "23503" });
      });
    });
  });

  it("orders the actual tenant catalog with messages before threads and runs", async () => {
    const { rows: tables } = await adminPool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'`,
    );
    const { rows: foreignKeys } = await adminPool.query<{ table_name: string; referenced_table: string }>(
      `SELECT child.relname AS table_name, parent.relname AS referenced_table
         FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = child.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public' AND NOT child.relispartition AND NOT parent.relispartition`,
    );
    const order = orderTablesForPurge(
      tables.map((row) => row.name),
      foreignKeys.map((row) => ({
        table: row.table_name,
        referencedTable: row.referenced_table,
      })),
    );
    const messages = order.indexOf("semp_messages");
    const threads = order.indexOf("semp_threads");
    const runs = order.indexOf("agent_runs");
    expect(messages).toBeGreaterThanOrEqual(0);
    expect(threads).toBeGreaterThan(messages);
    expect(runs).toBeGreaterThan(messages);
  });

  describe("thread uniqueness", () => {
    it("rejects a second tick thread for the same heartbeat", async () => {
      const heartbeatId = await insertHeartbeat();
      await insertThread("tick", { heartbeatId });
      await expect(insertThread("tick", { heartbeatId })).rejects.toMatchObject({
        code: "23505",
        constraint: "semp_threads_tick_heartbeat_uq",
      });
    });

    it("rejects a second item thread for the same Inbox item", async () => {
      const subjectInboxItemId = randomUUID();
      await insertThread("item", { subjectInboxItemId });
      await expect(insertThread("item", { subjectInboxItemId })).rejects.toMatchObject({
        code: "23505",
        constraint: "semp_threads_item_subject_uq",
      });
    });

    it("allows the same Inbox item id in two tenants", async () => {
      const subjectInboxItemId = randomUUID();
      await insertThread("item", { subjectInboxItemId });
      const tenantB = await createTestTenant(adminPool);
      await withTenantTransaction(adminPool, tenantB, (client) =>
        client.query("INSERT INTO semp_threads (kind, subject_inbox_item_id) VALUES ('item', $1)", [
          subjectInboxItemId,
        ]),
      );
    });

    it("creates an item thread with a null subject_proposal_id and defaults", async () => {
      const id = await insertThread("item", { subjectInboxItemId: randomUUID() });
      const { rows } = await adminPool.query<{ subject_proposal_id: string | null; title_source: string }>(
        "SELECT subject_proposal_id, title_source FROM semp_threads WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ subject_proposal_id: null, title_source: "auto" });
    });
  });

  describe("kind and column CHECK", () => {
    it("accepts one valid shape per kind", async () => {
      await insertThread("chat", { title: "A chat" });
      await insertThread("item", { subjectInboxItemId: randomUUID() });
      await insertThread("tick", { heartbeatId: await insertHeartbeat() });
    });

    it.each([
      ["chat with a subject", "chat", { subjectInboxItemId: randomUUID() }],
      ["chat with a heartbeat", "chat", "heartbeat"],
      ["item without a subject", "item", {}],
      ["item with a heartbeat", "item", { subjectInboxItemId: randomUUID(), heartbeatId: "heartbeat" }],
      ["tick without a heartbeat", "tick", {}],
      ["tick with a subject", "tick", { subjectInboxItemId: randomUUID(), heartbeatId: "heartbeat" }],
      ["item with a title", "item", { subjectInboxItemId: randomUUID(), title: "t" }],
    ] as const)("rejects %s", async (_label, kind, columns) => {
      const resolved = {
        ...(columns === "heartbeat" ? {} : columns),
      } as { subjectInboxItemId?: string; heartbeatId?: string; title?: string };
      if (columns === "heartbeat" || (columns as { heartbeatId?: string }).heartbeatId === "heartbeat") {
        resolved.heartbeatId = await insertHeartbeat();
      }
      await expect(insertThread(kind, resolved)).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects an unknown kind, title_source, role and status", async () => {
      await expect(adminPool.query("INSERT INTO semp_threads (kind) VALUES ('other')")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(
        adminPool.query("INSERT INTO semp_threads (kind, title_source) VALUES ('chat', 'other')"),
      ).rejects.toMatchObject({ code: "23514" });
      const threadId = await insertThread("chat");
      await expect(insertMessage(threadId, "tool")).rejects.toMatchObject({ code: "23514" });
      await expect(
        adminPool.query("INSERT INTO semp_messages (thread_id, role, status) VALUES ($1, 'assistant', 'other')", [
          threadId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("allows system_key and system_params only on system messages", async () => {
      const threadId = await insertThread("chat");
      await adminPool.query(
        `INSERT INTO semp_messages (thread_id, role, system_key, system_params)
         VALUES ($1, 'system', 'semp.thread.example', '{"a":1}'::jsonb)`,
        [threadId],
      );
      await expect(
        adminPool.query("INSERT INTO semp_messages (thread_id, role, system_key) VALUES ($1, 'user', 'k')", [threadId]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        adminPool.query("INSERT INTO semp_messages (thread_id, role, system_params) VALUES ($1, 'assistant', '{}')", [
          threadId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("foreign keys", () => {
    it("deletes a thread's messages with the thread", async () => {
      const threadId = await insertThread("chat");
      const otherThreadId = await insertThread("chat");
      await insertMessage(threadId);
      await insertMessage(otherThreadId);
      await adminPool.query("DELETE FROM semp_threads WHERE id = $1", [threadId]);
      const { rows } = await adminPool.query<{ thread_id: string }>("SELECT thread_id FROM semp_messages");
      expect(rows.map((row) => row.thread_id)).toEqual([otherThreadId]);
    });

    it("refuses to delete an agent run a message references, and a heartbeat a thread references", async () => {
      const run = await createAgentRun(adminPool, { triggeredBy: "user", task: "chat" });
      const threadId = await insertThread("chat");
      await insertMessage(threadId, "assistant", { agentRunId: run.id });
      await expect(adminPool.query("DELETE FROM agent_runs WHERE id = $1", [run.id])).rejects.toMatchObject({
        code: "23001",
      });

      const heartbeatId = await insertHeartbeat();
      await insertThread("tick", { heartbeatId });
      await expect(
        adminPool.query("DELETE FROM project_heartbeats WHERE id = $1", [heartbeatId]),
      ).rejects.toMatchObject({ code: "23001" });
    });

    it("links a reply to a message of the same tenant only", async () => {
      const threadId = await insertThread("chat");
      const userMessageId = await insertMessage(threadId);
      await adminPool.query(
        "INSERT INTO semp_messages (thread_id, role, reply_to_message_id) VALUES ($1, 'assistant', $2)",
        [threadId, userMessageId],
      );
      await expect(
        adminPool.query(
          "INSERT INTO semp_messages (thread_id, role, reply_to_message_id) VALUES ($1, 'assistant', $2)",
          [threadId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("keeps semp_messages rows older than 30 days through the agent run events retention job", async () => {
    const run = await createAgentRun(adminPool, { triggeredBy: "user", unit: "session", task: "chat" });
    await insertAgentRunEvent(adminPool, run.id, "message", { kind: "message" });
    await insertAgentRunEvent(adminPool, run.id, "compaction", { kind: "compaction" });
    await insertAgentRunEvent(adminPool, run.id, "message", { kind: "message" });
    await finishAgentRun(adminPool, run.id, "done", null);
    const old = new Date(Date.now() - 40 * DAY_MS);
    await adminPool.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [run.id, old]);

    const threadId = await insertThread("chat");
    const messageId = await insertMessage(threadId, "assistant", { agentRunId: run.id });
    await adminPool.query("UPDATE semp_messages SET created_at = $2, updated_at = $2 WHERE id = $1", [messageId, old]);

    const result = await handleAgentRunEventsRetentionTask(adminPool);
    expect(result.deleted).toBeGreaterThan(0);
    const { rows } = await adminPool.query("SELECT id FROM semp_messages");
    expect(rows).toHaveLength(1);
  });
});
