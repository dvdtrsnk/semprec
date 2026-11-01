import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser, projectAgentGuidanceStore } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { runAsSystem, runInTenant, type AiGatewayClientPort } from "@semprec/shared";
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
  source_id: string;
  dedupe_key: string;
  occurrence_count: number;
}
async function snapshot() {
  return withTenantTransaction(pool, tenant, async (client) => {
    const findings = await client.query<FindingRow>(
      "SELECT id, fingerprint, last_seen_at, status FROM agent_guidance_drift_findings ORDER BY fingerprint",
    );
    const problems = await client.query<ProblemRow>(
      "SELECT source_id, dedupe_key, occurrence_count FROM semp_problems ORDER BY dedupe_key",
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

  it("merges two activation notifications for one finding into one problem", async () => {
    let content: unknown = { contradictions: [finding("files.read", "first")] };
    const gateway: AiGatewayClientPort = {
      async complete() {
        return { content, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const action = createAgentGuidanceDriftActionForApi(pool, gateway);
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const first = await snapshot();
    content = { contradictions: [] };
    await runInTenant(tenant, () => action({ projectItemId: project }));
    content = { contradictions: [finding("files.read", "again")] };
    await runInTenant(tenant, () => action({ projectItemId: project }));
    const final = await snapshot();
    expect(final.findings).toHaveLength(1);
    expect(final.findings[0]?.id).toBe(first.findings[0]?.id);
    expect(final.findings[0]?.status).toBe("active");
    expect(final.problems).toHaveLength(1);
    expect(final.problems[0]).toMatchObject({ source_id: final.findings[0]?.id, occurrence_count: 2 });
    expect(final.notifications.filter((row) => row.kind === "agent_guidance_drift")).toHaveLength(2);
    expect(final.notifications.filter((row) => row.kind === "semp_problem")).toHaveLength(1);
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
