import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUser,
  projectAgentGuidanceStore,
  projectToolCallUsageStore,
  seedSystem,
  createChokePoint,
  createAgentRun,
  createResolveGuidanceDriftFindingRouteHandler,
  insertAgentRunEvent,
  getDatabaseByModuleId,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { fingerprintGuidanceDriftSubject, runAsSystem, runInTenant, type AiGatewayClientPort } from "@semprec/shared";
import { createAgentGuidanceDriftActionForApi } from "../projectAgentGuidanceComposition.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let project: string;
const finding = (operation: string, claim: string) => ({
  subject: { operation, databaseId: null },
  claim,
  guidanceExcerpt: `Excerpt ${claim}`,
  manifestFacts: [`Fact ${claim}`],
  severity: "warning",
});
interface FindingRow {
  id: string;
  fingerprint: string;
  last_seen_at: Date;
  status: string;
}
interface ProblemRow {
  id: string;
  source_id: string;
  dedupe_key: string;
  occurrence_count: number;
  resolution_kind: string | null;
}
async function snapshot() {
  return withTenantTransaction(pool, tenant, async (client) => {
    const findings = await client.query<FindingRow>(
      "SELECT id, fingerprint, last_seen_at, status FROM agent_guidance_drift_findings ORDER BY fingerprint",
    );
    const problems = await client.query<ProblemRow>(
      "SELECT id, source_id, dedupe_key, occurrence_count, resolution_kind FROM semp_problems ORDER BY dedupe_key, first_seen_at",
    );
    const notifications = await client.query<{ kind: string; source_id: string }>(
      "SELECT kind, source_id FROM notifications ORDER BY kind, source_id",
    );
    return { findings: findings.rows, problems: problems.rows, notifications: notifications.rows };
  });
}
describe("guidance drift production composition", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  it("connects stored tool events to behavior findings through the actual composition", async () => {
    const ownTenant = await createTestTenant(admin);
    const owner = await createUser(admin, {
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      tenantId: ownTenant,
      locale: "en",
    });
    await runInTenant(ownTenant, () => seedSystem(pool));
    const fixture = await runInTenant(ownTenant, async () => {
      const ids = await withTransaction(pool, async (tx) => ({
        projects: await getDatabaseByModuleId(tx, "projects"),
        tasks: await getDatabaseByModuleId(tx, "tasks"),
      }));
      if (!ids.projects || !ids.tasks) throw new Error("Missing system databases");
      const item = await createChokePoint(pool).createItem({
        databaseId: ids.projects.id,
        properties: { name: "Behavior project" },
      });
      await withTransaction(pool, (tx) =>
        projectAgentGuidanceStore.upsert(tx, {
          projectItemId: item.id,
          ownerUserId: owner.id,
          markdown: "## Allowed\nRead projects\n",
        }),
      );
      return { project: item.id, tasks: ids.tasks.id };
    });
    const addRun = () =>
      runInTenant(ownTenant, () =>
        withTransaction(pool, async (tx) => {
          const run = await createAgentRun(tx, {
            projectItemId: fixture.project,
            userId: owner.id,
            triggeredBy: "user",
            task: "test",
          });
          await insertAgentRunEvent(tx, run.id, "tool_use", {
            toolCallId: randomUUID(),
            name: "item_create",
            operation: "item.create",
            targetDatabaseId: fixture.tasks,
            arguments: {},
          });
          return run.id;
        }),
      );
    const runs = [await addRun(), await addRun()];
    const firstRun = runs[0];
    if (!firstRun) throw new Error("Missing first run");
    await runInTenant(ownTenant, () =>
      withTransaction(pool, async (tx) => {
        for (let index = 0; index < 999; index++) {
          await insertAgentRunEvent(tx, firstRun, "tool_use", {
            toolCallId: `bulk-${index}`,
            name: "item_create",
            operation: "item.create",
            targetDatabaseId: fixture.tasks,
            arguments: index === 0 ? { text: "x".repeat(70_000) } : {},
          });
        }
      }),
    );
    const fingerprint = fingerprintGuidanceDriftSubject(fixture.project, "behavior", {
      operation: "item.create",
      databaseId: fixture.tasks,
    });
    let behaviorCalls = 0;
    let report = true;
    let mentioned = false;
    let forbidden = false;
    let changeDuringCall = false;
    const gateway: AiGatewayClientPort = {
      async complete(input) {
        if (input.operation === "agent_guidance_drift")
          return { content: { contradictions: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
        expect(input.operation).toBe("agent_behavior_drift");
        expect(JSON.stringify(input.messages)).toContain("item.create");
        expect(JSON.stringify(input.messages)).toContain(mentioned ? "Create tasks" : "Read projects");
        const message = z.string().parse(input.messages[0]?.content);
        const payload = z
          .object({ locale: z.string(), notAllowed: z.string(), groups: z.array(z.object({ count: z.number() })) })
          .parse(JSON.parse(message));
        expect(payload.locale).toBe("en");
        expect(payload.groups).toHaveLength(1);
        expect(payload.groups[0]?.count).toBeGreaterThanOrEqual(3);
        if (forbidden) {
          expect(payload.notAllowed).toBe("Create tasks");
        }
        behaviorCalls++;
        if (changeDuringCall)
          await runInTenant(ownTenant, () =>
            withTransaction(pool, (tx) =>
              projectAgentGuidanceStore.upsert(tx, {
                projectItemId: fixture.project,
                ownerUserId: owner.id,
                markdown: "## Allowed\nChanged\n",
              }),
            ),
          );
        return {
          content: {
            findings: report
              ? [
                  {
                    fingerprint,
                    claim: "Creates tasks",
                    suggestedAllowedLine: "Allow task creation",
                    suggestedNotAllowedLine: "Forbid task creation",
                  },
                ]
              : [],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const action = createAgentGuidanceDriftActionForApi(pool, gateway);
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    expect(behaviorCalls).toBe(0);
    runs.push(await addRun());
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    const rows = () =>
      runInTenant(ownTenant, () =>
        pool.query<{ id: string; status: string; payload: unknown; last_seen_at: Date }>(
          "SELECT id, status, payload, last_seen_at FROM agent_guidance_drift_findings WHERE project_item_id = $1",
          [fixture.project],
        ),
      );
    const first = await rows();
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      status: "active",
      payload: {
        kind: "behavior",
        evidence: { count: 3 },
        suggestedAllowedLine: "Allow task creation",
        suggestedNotAllowedLine: "Forbid task creation",
      },
    });
    const evidence = z
      .object({ evidence: z.object({ runIds: z.array(z.string()), count: z.number() }) })
      .parse(first.rows[0]?.payload);
    expect(evidence.evidence.runIds.sort()).toEqual(runs.sort());
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    const repeated = await rows();
    expect(repeated.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(repeated.rows[0]!.last_seen_at.getTime()).toBeGreaterThan(first.rows[0]!.last_seen_at.getTime());
    const notifications = () =>
      runInTenant(ownTenant, () =>
        pool.query<{ kind: string }>("SELECT kind FROM notifications WHERE source_id = $1 ORDER BY kind", [
          first.rows[0]?.id,
        ]),
      );
    expect((await notifications()).rows).toEqual([{ kind: "agent_guidance_drift" }]);
    const foreign = await createTestTenant(admin);
    const beforeForeign = await rows();
    const callsBefore = behaviorCalls;
    await expect(runInTenant(foreign, () => action({ projectItemId: fixture.project }))).rejects.toMatchObject({
      name: "GuidanceMissingError",
    });
    await expect(runInTenant(foreign, () => action({ projectItemId: randomUUID() }))).rejects.toMatchObject({
      name: "GuidanceMissingError",
    });
    expect(behaviorCalls).toBe(callsBefore);
    expect((await rows()).rows).toEqual(beforeForeign.rows);
    await runInTenant(ownTenant, () =>
      withTransaction(pool, (tx) =>
        projectAgentGuidanceStore.upsert(tx, {
          projectItemId: fixture.project,
          ownerUserId: owner.id,
          markdown: "## Allowed\nCreate tasks\n",
        }),
      ),
    );
    mentioned = true;
    report = false;
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    expect((await rows()).rows[0]?.status).toBe("resolved");
    expect((await notifications()).rows.map((row) => row.kind)).toEqual([
      "agent_guidance_drift",
      "agent_guidance_drift_resolved",
    ]);
    await runInTenant(ownTenant, () =>
      withTransaction(pool, (tx) =>
        projectAgentGuidanceStore.upsert(tx, {
          projectItemId: fixture.project,
          ownerUserId: owner.id,
          markdown: "## Not allowed\nCreate tasks\n",
        }),
      ),
    );
    forbidden = true;
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    expect((await rows()).rows[0]?.status).toBe("resolved");
    expect((await notifications()).rows).toHaveLength(2);
    await runInTenant(ownTenant, () =>
      withTransaction(pool, (tx) =>
        projectAgentGuidanceStore.upsert(tx, {
          projectItemId: fixture.project,
          ownerUserId: owner.id,
          markdown: "## Allowed\nRead projects\n",
        }),
      ),
    );
    mentioned = false;
    forbidden = false;
    report = true;
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    expect((await rows()).rows[0]?.status).toBe("active");
    // The production event writer uses current time; model elapsed history with checked tenant-scoped fixture SQL.
    const aged = await runInTenant(ownTenant, () =>
      pool.query(
        "UPDATE agent_run_events SET at = now() - interval '15 days' WHERE agent_run_id = ANY($1::uuid[]) AND kind = 'tool_use'",
        [runs],
      ),
    );
    expect(aged.rowCount).toBe(1002);
    const callsBeforeExpiry = behaviorCalls;
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    expect(behaviorCalls).toBe(callsBeforeExpiry);
    expect((await rows()).rows[0]?.status).toBe("resolved");
    for (let index = 0; index < 3; index++) await addRun();
    changeDuringCall = true;
    await expect(runInTenant(ownTenant, () => action({ projectItemId: fixture.project }))).rejects.toMatchObject({
      name: "GuidanceChangedError",
    });
    expect((await rows()).rows[0]?.status).toBe("resolved");
    changeDuringCall = false;
    await runInTenant(ownTenant, () =>
      withTransaction(pool, (tx) =>
        projectAgentGuidanceStore.upsert(tx, {
          projectItemId: fixture.project,
          ownerUserId: owner.id,
          markdown: "## Allowed\nRead projects\n",
        }),
      ),
    );
    const overflowRuns = [await addRun(), await addRun(), await addRun()];
    await runInTenant(ownTenant, () => action({ projectItemId: fixture.project }));
    expect((await rows()).rows[0]?.status).toBe("active");
    const notificationsBeforeOverflow = (await notifications()).rows;
    const callsBeforeOverflow = behaviorCalls;
    await runInTenant(ownTenant, () =>
      withTransaction(pool, async (tx) => {
        for (let index = 0; index < 18; index++) {
          const registration = `${index}-${"x".repeat(60_000)}`;
          for (const run of overflowRuns) {
            await insertAgentRunEvent(tx, run, "tool_use", {
              toolCallId: `overflow-${index}`,
              name: "search",
              arguments: {},
              mcp: {
                toolRegistrationId: registration,
                serverItemId: "server",
                serverName: "server",
                toolName: "search",
              },
            });
          }
        }
      }),
    );
    await expect(runInTenant(ownTenant, () => action({ projectItemId: fixture.project }))).rejects.toThrow(
      "Behavior drift comparison input exceeds its limit",
    );
    expect(behaviorCalls).toBe(callsBeforeOverflow);
    expect((await rows()).rows[0]?.status).toBe("active");
    expect((await notifications()).rows).toEqual(notificationsBeforeOverflow);
    const isolated = await createRuntimeRolePool(admin, "semprec_data");
    try {
      let backendPid: number | undefined;
      await expect(
        runInTenant(ownTenant, () =>
          withTransaction(
            isolated,
            async (tx) => {
              backendPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              await projectToolCallUsageStore.listProjectToolCallGroups(
                tx,
                fixture.project,
                new Date(Date.now() - 14 * 86400_000),
              );
            },
            { isolation: "repeatable_read" },
          ),
        ),
      ).rejects.toThrow("Behavior drift comparison input exceeds its limit");
      await runInTenant(ownTenant, () =>
        withTransaction(isolated, async (tx) => {
          expect((await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid).toBe(backendPid);
          expect((await tx.query("SELECT name FROM pg_cursors WHERE name LIKE 'behavior_usage_%' ")).rowCount).toBe(0);
        }),
      );
    } finally {
      await isolated.end();
    }
  });
  it("rejects in-flight guidance changes even when the old observable millisecond collides", async () => {
    const ownTenant = await createTestTenant(admin);
    const owner = await createUser(admin, {
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      tenantId: ownTenant,
    });
    await runInTenant(ownTenant, () => seedSystem(pool));
    const fixture = await runInTenant(ownTenant, async () => {
      const ids = await withTransaction(pool, async (tx) => ({
        projects: await getDatabaseByModuleId(tx, "projects"),
        tasks: await getDatabaseByModuleId(tx, "tasks"),
      }));
      if (!ids.projects || !ids.tasks) throw new Error("Missing databases");
      const tasksId = ids.tasks.id;
      const item = await createChokePoint(pool).createItem({
        databaseId: ids.projects.id,
        properties: { name: "Race" },
      });
      await withTransaction(pool, async (tx) => {
        await projectAgentGuidanceStore.upsert(tx, {
          projectItemId: item.id,
          ownerUserId: owner.id,
          markdown: "## Allowed\nRead\n",
        });
        for (let index = 0; index < 3; index++) {
          const run = await createAgentRun(tx, {
            projectItemId: item.id,
            userId: owner.id,
            triggeredBy: "user",
            task: "race",
          });
          await insertAgentRunEvent(tx, run.id, "tool_use", {
            toolCallId: `race-${index}`,
            name: "create",
            arguments: {},
            operation: "item.create",
            targetDatabaseId: tasksId,
          });
        }
      });
      return { project: item.id, tasks: tasksId };
    });
    let releaseWrite: () => void = () => {};
    let reportStart: (date: Date) => void = () => {};
    const proceed = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const started = new Promise<Date>((resolve) => {
      reportStart = resolve;
    });
    const writing = runInTenant(ownTenant, () =>
      withTransaction(pool, async (tx) => {
        const clock = await tx.query<{ at: Date }>("SELECT now() AS at");
        if (!clock.rows[0]) throw new Error("Missing transaction clock");
        reportStart(clock.rows[0].at);
        await proceed;
        return projectAgentGuidanceStore.upsert(tx, {
          projectItemId: fixture.project,
          ownerUserId: owner.id,
          markdown: "## Allowed\nChanged\n",
        });
      }),
    );
    const writerTime = await Promise.race([
      started,
      writing.then(() => {
        throw new Error("Writer ended before release");
      }),
    ]);
    try {
      await runInTenant(ownTenant, async () => {
        // Synthetic historical timestamp: the public guidance owner cannot set an observed revision directly.
        expect(
          (
            await pool.query("UPDATE project_agent_guidance SET updated_at = $2 WHERE project_item_id = $1", [
              fixture.project,
              writerTime,
            ])
          ).rowCount,
        ).toBe(1);
      });
      const fingerprint = fingerprintGuidanceDriftSubject(fixture.project, "behavior", {
        operation: "item.create",
        databaseId: fixture.tasks,
      });
      const gateway: AiGatewayClientPort = {
        async complete(input) {
          if (input.operation === "agent_guidance_drift")
            return { content: { contradictions: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
          releaseWrite();
          await writing;
          return {
            content: {
              findings: [
                { fingerprint, claim: "Creates", suggestedAllowedLine: "Allow", suggestedNotAllowedLine: "Forbid" },
              ],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      await expect(
        runInTenant(ownTenant, () =>
          createAgentGuidanceDriftActionForApi(pool, gateway)({ projectItemId: fixture.project }),
        ),
      ).rejects.toMatchObject({ name: "GuidanceChangedError" });
      const findings = await runInTenant(ownTenant, () =>
        pool.query("SELECT id FROM agent_guidance_drift_findings WHERE project_item_id = $1", [fixture.project]),
      );
      expect(findings.rowCount).toBe(0);
    } finally {
      releaseWrite();
      await writing;
    }
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    const user = await runAsSystem("test-user", () =>
      createUser(admin, {
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
        tenantId: tenant,
      }),
    );
    project = await runInTenant(tenant, () => createTestProjectItem(pool));
    await withTenantTransaction(pool, tenant, (client) =>
      projectAgentGuidanceStore.upsert(client, { projectItemId: project, ownerUserId: user.id, markdown: "Guidance" }),
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });
  it.each(["allow", "forbid", "dismiss"] as const)(
    "keeps a manually decided %s finding closed on a later real drift action",
    async (choice) => {
      const ownTenant = await createTestTenant(admin);
      const owner = await createUser(admin, {
        tenantId: ownTenant,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      });
      await runInTenant(ownTenant, () => seedSystem(pool));
      const ownProject = await runInTenant(ownTenant, async () => {
        const database = await withTransaction(pool, (tx) => getDatabaseByModuleId(tx, "projects"));
        if (!database) throw new Error("Missing Projects database");
        const item = await createChokePoint(pool).createItem({
          databaseId: database.id,
          properties: { name: "Drift project" },
        });
        await withTransaction(pool, (tx) =>
          projectAgentGuidanceStore.upsert(tx, { projectItemId: item.id, ownerUserId: owner.id, markdown: "Guidance" }),
        );
        return item.id;
      });
      const guidance = await runInTenant(ownTenant, () =>
        withTransaction(pool, (tx) => projectAgentGuidanceStore.load(tx, ownProject)),
      );
      if (!guidance) throw new Error("Missing project guidance");
      const subject = { operation: "item.create", databaseId: null };
      const fingerprint = fingerprintGuidanceDriftSubject(ownProject, "behavior", subject);
      const addRun = () =>
        runInTenant(ownTenant, () =>
          withTransaction(pool, async (tx) => {
            const run = await createAgentRun(tx, {
              projectItemId: ownProject,
              userId: guidance.ownerUserId,
              triggeredBy: "user",
              task: "Drift detection",
            });
            await insertAgentRunEvent(tx, run.id, "tool_use", {
              toolCallId: randomUUID(),
              name: "item_create",
              operation: "item.create",
              arguments: {},
            });
            return run.id;
          }),
        );
      for (let i = 0; i < 3; i++) await addRun();
      const observed: Array<{ fingerprint: string; count: number }> = [];
      const gateway: AiGatewayClientPort = {
        async complete(input) {
          if (input.operation === "agent_guidance_drift")
            return { content: { contradictions: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
          expect(input.operation).toBe("agent_behavior_drift");
          const message = z.string().parse(input.messages[0]?.content);
          const request = z
            .object({ groups: z.array(z.object({ fingerprint: z.string(), count: z.number() })) })
            .parse(JSON.parse(message));
          expect(request.groups).toHaveLength(1);
          const group = request.groups[0];
          if (!group) throw new Error("Missing behavior group");
          observed.push(group);
          return {
            content: {
              findings: [
                {
                  fingerprint,
                  claim: "Creates tasks",
                  suggestedAllowedLine: "Create tasks from new GitHub issues.",
                  suggestedNotAllowedLine: "Do not create tasks.",
                },
              ],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const action = createAgentGuidanceDriftActionForApi(pool, gateway);
      await runInTenant(ownTenant, () => action({ projectItemId: ownProject }));
      const readFinding = () =>
        runInTenant(ownTenant, () =>
          pool.query<{
            id: string;
            fingerprint: string;
            status: string;
            resolution_choice: string | null;
            resolved_by: string | null;
          }>(
            "SELECT id, fingerprint, status, resolution_choice, resolved_by FROM agent_guidance_drift_findings WHERE project_item_id = $1",
            [ownProject],
          ),
        );
      const before = (await readFinding()).rows;
      expect(before).toHaveLength(1);
      const id = before[0]?.id;
      if (!id) throw new Error("Missing behavior finding");
      expect(before[0]).toMatchObject({ fingerprint, status: "active", resolution_choice: null, resolved_by: null });
      const route = createResolveGuidanceDriftFindingRouteHandler(pool);
      const decision = await runInTenant(ownTenant, () =>
        route({
          params: { id },
          identity: { user: { id: guidance.ownerUserId } },
          body: { choice, expectedGuidanceUpdatedAt: guidance.updatedAt },
        }),
      );
      expect(decision.status).toBe(200);
      if (decision.status !== 200 || !("guidance" in decision.body)) throw new Error("Decision failed");
      expect(decision.body.guidance.sections).toMatchObject({
        allowed: choice === "allow" ? "- Create tasks from new GitHub issues." : "",
        generalInstructions: "Guidance",
        notAllowed: choice === "forbid" ? "- Do not create tasks." : "",
      });
      const decided = (await readFinding()).rows;
      expect(decided).toEqual([
        {
          id,
          fingerprint,
          status: choice === "dismiss" ? "dismissed" : "resolved",
          resolution_choice: choice,
          resolved_by: guidance.ownerUserId,
        },
      ]);
      const readNotifications = () =>
        runInTenant(ownTenant, () =>
          pool.query<{ id: string; kind: string; source_id: string }>(
            "SELECT id, kind, source_id FROM notifications WHERE source_id = $1 ORDER BY kind, id",
            [id],
          ),
        );
      const notifications = (await readNotifications()).rows;
      expect(notifications.map((row) => row.kind)).toEqual(["agent_guidance_drift", "agent_guidance_drift_resolved"]);
      await addRun();
      await runInTenant(ownTenant, () => action({ projectItemId: ownProject }));
      expect(observed).toEqual([
        { fingerprint, count: 3 },
        { fingerprint, count: 4 },
      ]);
      expect((await readFinding()).rows).toEqual(decided);
      expect((await readNotifications()).rows).toEqual(notifications);
    },
  );

  it("reconciles reworded findings and problems through the real API composition and rejects a missing subject without writes", async () => {
    let content: unknown = { contradictions: [finding("files.read", "first")] };
    const gateway: AiGatewayClientPort = {
      async complete() {
        return { content, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const action = createAgentGuidanceDriftActionForApi(pool, gateway);
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const first = await snapshot();
    expect(first.findings).toHaveLength(1);
    expect(first.problems).toHaveLength(1);
    expect(first.problems[0]).toMatchObject({ source_id: first.findings[0]?.id, occurrence_count: 1 });
    expect(first.notifications.map((n) => n.kind).sort()).toEqual(["agent_guidance_drift", "semp_problem"]);
    const fanout = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = 'notificationFanout'",
    );
    expect(fanout.rows).toEqual([{ count: "2" }]);
    content = { contradictions: [finding("files.read", "reworded"), finding("files.write", "other")] };
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const second = await snapshot();
    expect(second.findings).toHaveLength(2);
    expect(second.problems).toHaveLength(2);
    const original = second.findings.find((row) => row.id === first.findings[0]?.id);
    expect(original?.fingerprint).toBe(first.findings[0]?.fingerprint);
    expect(original?.status).toBe("active");
    expect(original?.last_seen_at.getTime()).toBeGreaterThan(first.findings[0]?.last_seen_at.getTime() ?? Infinity);
    expect(second.notifications).toHaveLength(4);
    content = {
      contradictions: [{ claim: "missing subject", guidanceExcerpt: "x", manifestFacts: ["x"], severity: "warning" }],
    };
    await expect(runInTenant(tenant, () => action({ projectItemId: project }))).rejects.toThrow(/missing its subject/);
    expect(await snapshot()).toEqual(second);
  });

  it("does not expose a foreign project's guidance or call the gateway", async () => {
    const otherTenant = await createTestTenant(admin);
    let calls = 0;
    const gateway: AiGatewayClientPort = {
      async complete() {
        calls += 1;
        return { content: { contradictions: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const action = createAgentGuidanceDriftActionForApi(pool, gateway);
    const before = await snapshot();
    await expect(runInTenant(otherTenant, () => action({ projectItemId: project }))).rejects.toMatchObject({
      name: "GuidanceMissingError",
    });
    expect(calls).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("resolves the problem of a resolved finding and starts a new one when the finding returns", async () => {
    tenant = await createTestTenant(admin);
    const owner = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    await runInTenant(tenant, () => seedSystem(pool));
    project = await runInTenant(tenant, async () => {
      const database = await withTransaction(pool, (tx) => getDatabaseByModuleId(tx, "projects"));
      if (!database) throw new Error("Missing Projects database");
      const item = await createChokePoint(pool).createItem({
        databaseId: database.id,
        properties: { name: "Drift project" },
      });
      await withTransaction(pool, (tx) =>
        projectAgentGuidanceStore.upsert(tx, { projectItemId: item.id, ownerUserId: owner.id, markdown: "Guidance" }),
      );
      return item.id;
    });
    let content: unknown = { contradictions: [finding("files.read", "first")] };
    const gateway: AiGatewayClientPort = {
      async complete() {
        return { content, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const action = createAgentGuidanceDriftActionForApi(pool, gateway);
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const first = await snapshot();
    expect(first.problems).toMatchObject([{ resolution_kind: null }]);
    content = { contradictions: [] };
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const resolved = await snapshot();
    expect(resolved.findings).toMatchObject([{ status: "resolved" }]);
    expect(resolved.problems).toMatchObject([{ id: first.problems[0]?.id, resolution_kind: "recovered" }]);
    content = { contradictions: [finding("files.read", "again")] };
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const final = await snapshot();
    expect(final.findings).toHaveLength(1);
    expect(final.findings[0]?.id).toBe(first.findings[0]?.id);
    expect(final.findings[0]?.status).toBe("active");
    // the returning finding is a new episode: the resolved problem stays resolved and a new one is active
    expect(final.problems).toHaveLength(2);
    expect(final.problems[0]).toMatchObject({
      id: first.problems[0]?.id,
      occurrence_count: 1,
      resolution_kind: "recovered",
    });
    expect(final.problems[1]).toMatchObject({
      source_id: final.findings[0]?.id,
      occurrence_count: 1,
      resolution_kind: null,
    });
    expect(final.problems[1]?.id).not.toBe(first.problems[0]?.id);
    expect(final.notifications.filter((row) => row.kind === "agent_guidance_drift")).toHaveLength(2);
    expect(final.notifications.filter((row) => row.kind === "semp_problem")).toHaveLength(2);
  });

  it("rolls back the finding and notification when the problem write fails", async () => {
    const gateway: AiGatewayClientPort = {
      async complete() {
        return {
          content: { contradictions: [finding("files.read", "first")] },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    // Fault injection: no production path deliberately fails between notification and problem writes.
    await admin.query(`CREATE FUNCTION test_fail_guidance_problem() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected problem failure'; END $$`);
    try {
      await admin.query(`CREATE TRIGGER test_fail_guidance_problem BEFORE INSERT ON semp_problems
        FOR EACH ROW EXECUTE FUNCTION test_fail_guidance_problem()`);
      const before = await snapshot();
      const jobsBefore = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = 'notificationFanout'",
      );
      const action = createAgentGuidanceDriftActionForApi(pool, gateway);
      await expect(runInTenant(tenant, () => action({ projectItemId: project }))).rejects.toThrow(
        "injected problem failure",
      );
      expect(await snapshot()).toEqual(before);
      const jobsAfter = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE task_identifier = 'notificationFanout'",
      );
      expect(jobsAfter.rows).toEqual(jobsBefore.rows);
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_fail_guidance_problem ON semp_problems");
      await admin.query("DROP FUNCTION IF EXISTS test_fail_guidance_problem()");
    }
  });
});
