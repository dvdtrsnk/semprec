import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import {
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
  guidanceDriftHeartbeatStore,
} from "../guidanceDrift/guidanceDriftHeartbeatStore.js";
import { agentGuidanceDriftFindingsStore } from "../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import type { GuidanceDriftContradiction } from "@semprec/shared";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";
import { projectToolCallUsageStore } from "../guidanceDrift/projectToolCallUsageStore.js";

let pool: Pool;

async function createProjectItem(): Promise<string> {
  const item = await withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("Projects database was not seeded");
    return insertItem(client, { databaseId: database.id, properties: { name: `Project ${randomUUID()}` } });
  });
  return item.id;
}

const CONTRADICTION: GuidanceDriftContradiction = {
  kind: "permission",
  subject: { operation: "files.delete", databaseId: null },
  claim: "The agent can delete files without approval.",
  guidanceExcerpt: "Agents may delete any file directly.",
  manifestFacts: ["capability.files.delete requires approval"],
  severity: "blocking",
};

describe("guidanceDrift stores (issue #85)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("groups typed generic and MCP events by distinct run inside the runtime tenant", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runAsSystem("test:role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const a = await createTestTenant(pool);
      const b = await createTestTenant(pool);
      const userA = await createUser(pool, { email: "drift-a@example.test", passwordHash: "hash", tenantId: a });
      const userB = await createUser(pool, { email: "drift-b@example.test", passwordHash: "hash", tenantId: b });
      const projectA = randomUUID();
      const projectB = randomUUID();
      const databaseId = randomUUID();
      for (const [tenant, user, project] of [
        [a, userA.id, projectA],
        [b, userB.id, projectB],
      ] as const) {
        await runInTenant(tenant, () =>
          withTransaction(runtime, async (tx) => {
            for (let index = 0; index < 3; index++) {
              const run = await createAgentRun(tx, {
                projectItemId: project,
                userId: user,
                triggeredBy: "user",
                task: "test",
              });
              await insertAgentRunEvent(tx, run.id, "tool_use", {
                toolCallId: `c${index}`,
                name: "create",
                arguments: {},
                operation: "item.create",
                targetDatabaseId: databaseId,
              });
              if (index === 0)
                await insertAgentRunEvent(tx, run.id, "tool_use", {
                  toolCallId: "duplicate",
                  name: "create",
                  arguments: {},
                  operation: "item.create",
                  targetDatabaseId: databaseId,
                });
              if (index === 0) {
                await insertAgentRunEvent(tx, run.id, "tool_use", { toolCallId: "legacy", name: "old", arguments: {} });
                await insertAgentRunEvent(tx, run.id, "tool_use", {
                  toolCallId: "malformed",
                  name: "bad",
                  arguments: {},
                  operation: "not.a.real.operation",
                });
              }
              await insertAgentRunEvent(tx, run.id, "tool_use", {
                toolCallId: `m${index}`,
                name: "search",
                arguments: {},
                mcp: {
                  toolRegistrationId: "registration",
                  serverItemId: "server",
                  serverName: index === 2 ? "Newest" : "Server",
                  toolName: "search",
                },
              });
            }
          }),
        );
      }
      await runInTenant(a, () =>
        withTransaction(runtime, async (tx) => {
          for (let index = 0; index < 21; index++) {
            const run = await createAgentRun(tx, {
              projectItemId: projectA,
              userId: userA.id,
              triggeredBy: "user",
              task: "recent runs",
            });
            await insertAgentRunEvent(tx, run.id, "tool_use", {
              toolCallId: `patch${index}`,
              name: "patch",
              arguments: {},
              operation: "item.patch",
              targetDatabaseId: databaseId,
            });
          }
        }),
      );
      await runInTenant(a, async () => {
        // Synthetic historical event timestamps: the event writer cannot select sub-millisecond times.
        const aged = await runtime.query(
          `UPDATE agent_run_events e SET at = date_trunc('second', now()) - interval '1 second'
             + (1000 - (e.id % 1000)) * interval '1 microsecond'
           FROM agent_runs r WHERE r.id = e.agent_run_id AND r.project_item_id = $1
             AND e.kind = 'tool_use' AND e.payload->>'operation' = 'item.patch'`,
          [projectA],
        );
        expect(aged.rowCount).toBe(21);
      });
      const since = new Date(Date.now() - 14 * 86400_000);
      const groups = await runInTenant(a, () =>
        withTransaction(runtime, async (tx) => {
          const result = await projectToolCallUsageStore.listProjectToolCallGroups(tx, projectA, since);
          const cursors = await tx.query("SELECT name FROM pg_cursors WHERE name LIKE 'behavior_usage_%'");
          expect(cursors.rowCount).toBe(0);
          return result;
        }),
      );
      expect(groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subject: { operation: "item.create", databaseId }, count: 3 }),
          expect.objectContaining({ subject: { operation: "item.patch", databaseId }, count: 21 }),
          expect.objectContaining({
            subject: { mcpTool: "registration", databaseId: null },
            count: 3,
            toolName: "Newest/search",
          }),
        ]),
      );
      expect(groups).toHaveLength(3);
      const recent = await runInTenant(a, () =>
        runtime.query<{ run_id: string }>(
          `SELECT e.agent_run_id AS run_id FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id
           WHERE r.project_item_id = $1 AND e.kind = 'tool_use' AND e.payload->>'operation' = 'item.patch'
           ORDER BY e.at DESC, e.id DESC LIMIT 20`,
          [projectA],
        ),
      );
      const patchGroup = groups.find(
        (group) => "operation" in group.subject && group.subject.operation === "item.patch",
      );
      expect(patchGroup?.runIds).toEqual(recent.rows.map((row) => row.run_id));
      expect(new Set(patchGroup?.runIds).size).toBe(20);
      expect(
        await runInTenant(a, () =>
          withTransaction(runtime, (tx) => projectToolCallUsageStore.listProjectToolCallGroups(tx, projectB, since)),
        ),
      ).toEqual([]);
      expect(
        await runInTenant(a, () =>
          withTransaction(runtime, (tx) =>
            projectToolCallUsageStore.listProjectToolCallGroups(tx, randomUUID(), since),
          ),
        ),
      ).toEqual([]);
    } finally {
      await runtime.end();
    }
  });

  it.each(["many events", "large event"])("retains valid groups with %s in the window", async (scenario) => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runAsSystem("test:role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = await createTestTenant(pool);
      const user = await createUser(pool, {
        email: `${randomUUID()}@example.test`,
        passwordHash: "hash",
        tenantId: tenant,
      });
      const project = randomUUID();
      await runInTenant(tenant, () =>
        withTransaction(runtime, async (tx) => {
          const runs = [];
          for (let index = 0; index < 3; index++) {
            runs.push(
              await createAgentRun(tx, { projectItemId: project, userId: user.id, triggeredBy: "user", task: "test" }),
            );
          }
          const count = scenario === "many events" ? 1_001 : 3;
          for (let index = 0; index < count; index++) {
            const run = runs[index % runs.length];
            if (!run) throw new Error("Missing run");
            await insertAgentRunEvent(tx, run.id, "tool_use", {
              toolCallId: `call${index}`,
              name: "create",
              arguments: scenario === "large event" && index === 0 ? { text: "x".repeat(70_000) } : {},
              operation: "item.create",
            });
          }
        }),
      );
      const groups = await runInTenant(tenant, () =>
        withTransaction(runtime, (tx) =>
          projectToolCallUsageStore.listProjectToolCallGroups(tx, project, new Date(Date.now() - 14 * 86400_000)),
        ),
      );
      expect(groups).toContainEqual(
        expect.objectContaining({ subject: { operation: "item.create", databaseId: null }, count: 3 }),
      );
    } finally {
      await runtime.end();
    }
  });

  describe("guidanceDriftHeartbeatStore", () => {
    it("creates exactly one canonical heartbeat for a project", async () => {
      const projectItemId = await createProjectItem();

      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));

      const { rows } = await pool.query<{
        name: string;
        rule: { kind: string; at: string };
        action_id: string;
        action_config: Record<string, unknown>;
        enabled: boolean;
        next_fire_at: Date | null;
      }>(
        `SELECT name, rule, action_id, action_config, enabled, next_fire_at FROM project_heartbeats
         WHERE project_item_id = $1 AND action_id = $2`,
        [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Detect agent guidance drift",
        rule: { kind: "dailyTime", at: "04:30" },
        action_id: "core.agentGuidanceDrift",
        action_config: {},
        enabled: true,
      });
      expect(rows[0]?.next_fire_at).not.toBeNull();
    });

    it("stays a single row under repeated upserts, enforced by the partial unique index", async () => {
      const projectItemId = await createProjectItem();

      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));
      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));
      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM project_heartbeats WHERE project_item_id = $1 AND action_id = $2`,
        [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
      );
      expect(rows[0]?.count).toBe(1);
    });

    it("re-enables a previously disabled heartbeat on the next upsert", async () => {
      const projectItemId = await createProjectItem();
      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));
      await pool.query(`UPDATE project_heartbeats SET enabled = false WHERE project_item_id = $1 AND action_id = $2`, [
        projectItemId,
        AGENT_GUIDANCE_DRIFT_ACTION_ID,
      ]);

      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));

      const { rows } = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = $2`,
        [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
      );
      expect(rows[0]?.enabled).toBe(true);
    });
  });

  describe("agentGuidanceDriftFindingsStore", () => {
    it("transitions insert -> active, repeat observe -> no transition, resolve -> resolved, reappear -> active again", async () => {
      const projectItemId = await createProjectItem();
      const fingerprint = "f".repeat(64);
      const seenAt1 = new Date("2026-01-01T00:00:00.000Z");
      const seenAt2 = new Date("2026-01-02T00:00:00.000Z");
      const resolvedAt = new Date("2026-01-03T00:00:00.000Z");
      const seenAt3 = new Date("2026-01-04T00:00:00.000Z");

      const first = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint,
          payload: CONTRADICTION,
          seenAt: seenAt1,
        }),
      );
      expect(first.transitionedToActive).toBe(true);

      const repeat = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint,
          payload: CONTRADICTION,
          seenAt: seenAt2,
        }),
      );
      expect(repeat.transitionedToActive).toBe(false);
      expect(repeat.finding.id).toBe(first.finding.id);
      expect(repeat.finding.lastSeenAt).toBe(seenAt2.toISOString());

      const resolved = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.resolve(client, first.finding.id, resolvedAt),
      );
      expect(resolved.transitionedToResolved).toBe(true);

      const resolveAgain = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.resolve(client, first.finding.id, resolvedAt),
      );
      expect(resolveAgain.transitionedToResolved).toBe(false);

      const reactivated = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint,
          payload: CONTRADICTION,
          seenAt: seenAt3,
        }),
      );
      expect(reactivated.transitionedToActive).toBe(true);
      expect(reactivated.finding.id).toBe(first.finding.id);
      expect(reactivated.finding.resolvedAt).toBeNull();
    });

    it("listActive returns only active findings for the given project", async () => {
      const projectItemId = await createProjectItem();
      const otherProjectItemId = await createProjectItem();
      const seenAt = new Date("2026-01-01T00:00:00.000Z");

      const active = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint: "a".repeat(64),
          payload: CONTRADICTION,
          seenAt,
        }),
      );
      const toResolve = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint: "b".repeat(64),
          payload: CONTRADICTION,
          seenAt,
        }),
      );
      await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.resolve(client, toResolve.finding.id, seenAt),
      );
      await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId: otherProjectItemId,
          fingerprint: "c".repeat(64),
          payload: CONTRADICTION,
          seenAt,
        }),
      );

      const listed = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.listActive(client, projectItemId),
      );
      expect(listed.map((row) => row.id)).toEqual([active.finding.id]);
    });
  });
});

// `createGuidanceNotificationWriter`'s tests live in `packages/notifications` (issue #85's
// AC #46: the writer itself moved there too, on top of that package's `createNotification`),
// exercised against `@semprec/data`'s public API rather than these internal fixtures.
