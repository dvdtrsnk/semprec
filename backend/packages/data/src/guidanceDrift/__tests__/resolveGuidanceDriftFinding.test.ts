import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { saveGuidanceSections } from "../../projectAgentGuidance/projectAgentGuidanceSections.js";
import { agentGuidanceDriftFindingsStore } from "../agentGuidanceDriftFindingsStore.js";
import { createResolveGuidanceDriftFindingRouteHandler } from "../guidanceDriftFindingsRouteHandlers.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let user: string;
let project: string;
const sections = { purpose: "Purpose", allowed: "Existing", notAllowed: "", generalInstructions: "" };
const payload = {
  kind: "behavior" as const,
  subject: { mcpTool: "search", databaseId: null },
  claim: "Claim",
  evidence: { runIds: ["one", "two", "three"], count: 3 },
  suggestedAllowedLine: "Create tasks from new GitHub issues.",
  suggestedNotAllowedLine: "Do not create tasks.",
  severity: "warning" as const,
};

describe("guidance drift decisions", () => {
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
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    user = (
      await createUser(admin, { email: "owner@example.test", passwordHash: "hash", tenantId: tenant, locale: "en" })
    ).id;
    await runInTenant(tenant, () => seedSystem(pool));
    project = await runInTenant(tenant, async () => {
      const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
      if (!db.rows[0]) throw new Error("Missing projects");
      return (await createChokePoint(pool).createItem({ databaseId: db.rows[0].id, properties: { name: "Project" } }))
        .id;
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("adds decision columns to populated historical rows in two tenants", async () => {
    const other = await createTestTenant(admin);
    await createUser(admin, { email: "other@example.test", passwordHash: "hash", tenantId: other });
    await runInTenant(other, () => seedSystem(pool));
    const otherProject = await runInTenant(other, async () => {
      const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
      if (!db.rows[0]) throw new Error("Missing projects");
      return (await createChokePoint(pool).createItem({ databaseId: db.rows[0].id, properties: { name: "Other" } })).id;
    });
    const ids: string[] = [];
    for (const [scope, projectId] of [
      [tenant, project],
      [other, otherProject],
    ] as const) {
      const finding = await runInTenant(scope, () =>
        withTransaction(pool, (tx) =>
          agentGuidanceDriftFindingsStore.upsertActive(tx, {
            projectItemId: projectId,
            fingerprint: "c".repeat(64),
            payload,
            seenAt: new Date("2026-01-01T00:00:00Z"),
          }),
        ),
      );
      ids.push(finding.finding.id);
    }
    const sql = await readFile(
      new URL("../../db/migrations/0145_guidance_drift_finding_decisions.sql", import.meta.url),
      "utf8",
    );
    // Synthetic historical schema: global setup already applied the migration to this test database.
    await runAsSystem("test:historical-guidance-schema", () =>
      withTransaction(admin, async (client) => {
        await client.query(
          "ALTER TABLE agent_guidance_drift_findings DROP CONSTRAINT agent_guidance_drift_findings_status_check",
        );
        await client.query(
          "ALTER TABLE agent_guidance_drift_findings DROP COLUMN resolution_choice, DROP COLUMN resolved_by",
        );
        await client.query(
          "ALTER TABLE agent_guidance_drift_findings ADD CONSTRAINT agent_guidance_drift_findings_status_check CHECK (status IN ('active', 'resolved'))",
        );
        await client.query(sql);
      }),
    );
    for (const [scope, id] of [
      [tenant, ids[0]],
      [other, ids[1]],
    ] as const) {
      const result = await runInTenant(scope, () =>
        pool.query<{ id: string; status: string; resolved_by: string | null; resolution_choice: string | null }>(
          "SELECT id, status, resolved_by, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
          [id],
        ),
      );
      expect(result.rows).toEqual([{ id, status: "active", resolved_by: null, resolution_choice: null }]);
    }
  });
  it.each(["allow", "forbid", "dismiss"] as const)("decides %s once and never reopens it", async (choice) =>
    runInTenant(tenant, async () => {
      const saved = await withTransaction(pool, (tx) =>
        saveGuidanceSections(tx, { actorUserId: user, projectItemId: project, sections, expectedUpdatedAt: null }),
      );
      const first = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "a".repeat(64),
          payload,
          seenAt: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      const route = createResolveGuidanceDriftFindingRouteHandler(pool);
      const response = await route({
        params: { id: first.finding.id },
        identity: { user: { id: user } },
        body: { choice, expectedGuidanceUpdatedAt: saved.updatedAt },
      });
      expect(response.status).toBe(200);
      if (response.status !== 200) throw new Error("Decision failed");
      expect(response.body).toMatchObject({
        finding: { id: first.finding.id, status: choice === "dismiss" ? "dismissed" : "resolved" },
        guidance: {
          sections: {
            ...sections,
            allowed: choice === "allow" ? "Existing\n- Create tasks from new GitHub issues." : "Existing",
            notAllowed: choice === "forbid" ? "- Do not create tasks." : "",
          },
        },
      });
      const row = await pool.query<{ status: string; resolved_by: string; resolution_choice: string }>(
        "SELECT status, resolved_by, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
        [first.finding.id],
      );
      expect(row.rows).toEqual([
        { status: choice === "dismiss" ? "dismissed" : "resolved", resolved_by: user, resolution_choice: choice },
      ]);
      const later = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "a".repeat(64),
          payload,
          seenAt: new Date("2026-01-02T00:00:00Z"),
        }),
      );
      expect(later.transitionedToActive).toBe(false);
      expect(later.finding.status).toBe(choice === "dismiss" ? "dismissed" : "resolved");
      const notification = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM notifications WHERE source_id = $1 AND kind = 'agent_guidance_drift_resolved'",
        [first.finding.id],
      );
      expect(notification.rows).toEqual([
        {
          payload: {
            projectItemId: project,
            fingerprint: "a".repeat(64),
            kind: "behavior",
            resolutionTitle: "Instructions of project Project match what Semp does again",
          },
        },
      ]);
    }),
  );
  it("refuses stale, non-owner and inapplicable decisions without changing the finding or guidance", async () =>
    runInTenant(tenant, async () => {
      const saved = await withTransaction(pool, (tx) =>
        saveGuidanceSections(tx, { actorUserId: user, projectItemId: project, sections, expectedUpdatedAt: null }),
      );
      const permission = {
        kind: "permission" as const,
        subject: { operation: "item.create", databaseId: null },
        claim: "Claim",
        guidanceExcerpt: "Excerpt",
        manifestFacts: ["Fact"],
        severity: "warning" as const,
      };
      const first = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "b".repeat(64),
          payload: permission,
          seenAt: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      const route = createResolveGuidanceDriftFindingRouteHandler(pool);
      const context = (actor: string, choice: "allow" | "dismiss", version: string | null) => ({
        params: { id: first.finding.id },
        identity: { user: { id: actor } },
        body: { choice, expectedGuidanceUpdatedAt: version },
      });
      expect(await route(context(user, "dismiss", null))).toMatchObject({
        status: 409,
        body: { error: { code: "version_conflict" } },
      });
      await expect(
        route(context("00000000-0000-4000-8000-000000000000", "dismiss", saved.updatedAt)),
      ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
      await expect(route(context(user, "allow", saved.updatedAt))).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "choice", reason: "not_applicable" },
      });
      const rows = await pool.query<{ status: string; resolution_choice: string | null }>(
        "SELECT status, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
        [first.finding.id],
      );
      expect(rows.rows).toEqual([{ status: "active", resolution_choice: null }]);
      const notifications = await pool.query("SELECT id FROM notifications WHERE source_id = $1", [first.finding.id]);
      expect(notifications.rows).toEqual([]);
      expect((await route(context(user, "dismiss", saved.updatedAt))).status).toBe(200);
      const resolved = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM notifications WHERE source_id = $1",
        [first.finding.id],
      );
      expect(resolved.rows).toEqual([
        {
          payload: {
            projectItemId: project,
            fingerprint: "b".repeat(64),
            kind: "permission",
            resolutionTitle: "Instructions of project Project match the permissions again",
          },
        },
      ]);
    }));
  it("localizes a behavior resolution in Czech for the owner", async () => {
    const changed = await admin.query("UPDATE users SET locale = 'cs' WHERE id = $1", [user]);
    expect(changed.rowCount).toBe(1);
    await runInTenant(tenant, async () => {
      const saved = await withTransaction(pool, (tx) =>
        saveGuidanceSections(tx, { actorUserId: user, projectItemId: project, sections, expectedUpdatedAt: null }),
      );
      const first = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "d".repeat(64),
          payload,
          seenAt: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      const route = createResolveGuidanceDriftFindingRouteHandler(pool);
      expect(
        (
          await route({
            params: { id: first.finding.id },
            identity: { user: { id: user } },
            body: { choice: "dismiss", expectedGuidanceUpdatedAt: saved.updatedAt },
          })
        ).status,
      ).toBe(200);
      const rows = await pool.query<{ payload: unknown }>("SELECT payload FROM notifications WHERE source_id = $1", [
        first.finding.id,
      ]);
      expect(rows.rows).toEqual([
        {
          payload: {
            projectItemId: project,
            fingerprint: "d".repeat(64),
            kind: "behavior",
            resolutionTitle: "Pokyny projektu Project opět odpovídají tomu, co Semp dělá",
          },
        },
      ]);
    });
  });
});
