import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { agentGuidanceDriftFindingsStore } from "../../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  createProjectAgentGuidanceReadRouteHandler,
  createProjectAgentGuidanceSaveRouteHandler,
} from "../projectAgentGuidanceRouteHandlers.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let user: string;
let project: string;
const sections = {
  purpose: "Coordinate",
  allowed: "Read tasks",
  notAllowed: "Delete tasks",
  generalInstructions: "Be concise",
};
describe("project agent guidance sections", () => {
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
    user = (await createUser(admin, { email: "owner@example.test", passwordHash: "hash", tenantId: tenant })).id;
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
  const context = (id: string, userId: string, body: unknown) => ({
    params: { id },
    identity: { user: { id: userId } },
    body,
  });
  it("loads empty, saves, rejects stale and wrong owner, then deletes and disables its heartbeat", async () =>
    runInTenant(tenant, async () => {
      const read = createProjectAgentGuidanceReadRouteHandler(pool);
      const save = createProjectAgentGuidanceSaveRouteHandler(pool);
      expect((await read(context(project, user, null))).body).toEqual({
        sections: { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" },
        updatedAt: null,
        ownerUserId: null,
      });
      const noOp = await save(
        context(project, user, {
          sections: { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" },
          expectedUpdatedAt: null,
        }),
      );
      expect(noOp).toMatchObject({ status: 200, body: { updatedAt: null } });
      expect(
        (await pool.query("SELECT project_item_id FROM project_agent_guidance WHERE project_item_id = $1", [project]))
          .rowCount,
      ).toBe(0);
      const saved = await save(context(project, user, { sections, expectedUpdatedAt: null }));
      expect(saved.status).toBe(200);
      const loaded = (await read(context(project, user, null))).body;
      expect(loaded).toMatchObject({ sections, ownerUserId: user });
      const stale = await save(context(project, user, { sections, expectedUpdatedAt: null }));
      expect(stale).toMatchObject({
        status: 409,
        body: { error: { code: "version_conflict", details: { current: { sections } } } },
      });
      await expect(
        save(
          context(project, "00000000-0000-4000-8000-000000000000", { sections, expectedUpdatedAt: loaded.updatedAt }),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });
      const heartbeats = await pool.query<{ enabled: boolean }>(
        "SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
        [project],
      );
      expect(heartbeats.rows).toEqual([{ enabled: true }]);
      const finding = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "a".repeat(64),
          seenAt: new Date(),
          payload: {
            kind: "permission",
            subject: { operation: "item.create", databaseId: null },
            claim: "Claim",
            guidanceExcerpt: "Excerpt",
            manifestFacts: ["Fact"],
            severity: "warning",
          },
        }),
      );
      const emptied = await save(
        context(project, user, {
          sections: { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" },
          expectedUpdatedAt: loaded.updatedAt,
        }),
      );
      expect(emptied).toMatchObject({ status: 200, body: { updatedAt: null } });
      expect(
        (await pool.query("SELECT project_item_id FROM project_agent_guidance WHERE project_item_id = $1", [project]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query<{ enabled: boolean }>(
            "SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
            [project],
          )
        ).rows,
      ).toEqual([{ enabled: false }]);
      expect(
        (
          await pool.query<{ status: string }>("SELECT status FROM agent_guidance_drift_findings WHERE id = $1", [
            finding.finding.id,
          ])
        ).rows,
      ).toEqual([{ status: "resolved" }]);
      expect(
        (
          await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM notifications WHERE source_id = $1", [
            finding.finding.id,
          ])
        ).rows,
      ).toEqual([{ count: 0 }]);
    }));
  it("rejects reserved headings and oversized content", async () =>
    runInTenant(tenant, async () => {
      const save = createProjectAgentGuidanceSaveRouteHandler(pool);
      await expect(
        save(context(project, user, { sections: { ...sections, allowed: "## Allowed" }, expectedUpdatedAt: null })),
      ).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "sections.allowed", reason: "reserved_heading" },
      });
      await expect(
        save(
          context(project, user, { sections: { ...sections, purpose: "a".repeat(32769) }, expectedUpdatedAt: null }),
        ),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "sections", reason: "too_long" } });
    }));
  it("allows one of two concurrent writes with the same expected version", async () =>
    runInTenant(tenant, async () => {
      const read = createProjectAgentGuidanceReadRouteHandler(pool);
      const save = createProjectAgentGuidanceSaveRouteHandler(pool);
      await save(context(project, user, { sections, expectedUpdatedAt: null }));
      const current = (await read(context(project, user, null))).body;
      const results = await Promise.all([
        save(
          context(project, user, { sections: { ...sections, purpose: "First" }, expectedUpdatedAt: current.updatedAt }),
        ),
        save(
          context(project, user, {
            sections: { ...sections, purpose: "Second" },
            expectedUpdatedAt: current.updatedAt,
          }),
        ),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const after = (await read(context(project, user, null))).body;
      expect(["First", "Second"]).toContain(after.sections.purpose);
    }));
  it("maps a serialization failure after a write to conflict and rolls the write back", async () =>
    runInTenant(tenant, async () => {
      const read = createProjectAgentGuidanceReadRouteHandler(pool);
      const save = createProjectAgentGuidanceSaveRouteHandler(pool);
      await save(context(project, user, { sections, expectedUpdatedAt: null }));
      const before = (await read(context(project, user, null))).body;
      const original = projectAgentGuidanceStore.upsert.bind(projectAgentGuidanceStore);
      const failure = Object.assign(new Error("Injected serialization failure"), { code: "40001" });
      const spy = vi.spyOn(projectAgentGuidanceStore, "upsert").mockImplementation(async (tx, input) => {
        await original(tx, input);
        throw failure;
      });
      try {
        const result = await save(
          context(project, user, {
            sections: { ...sections, purpose: "Rolled back" },
            expectedUpdatedAt: before.updatedAt,
          }),
        );
        expect(spy).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
          status: 409,
          body: { error: { code: "version_conflict", details: { current: before } } },
        });
        expect((await read(context(project, user, null))).body).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    }));
});
