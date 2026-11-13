import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { saveGuidanceSections } from "../../projectAgentGuidance/projectAgentGuidanceSections.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createGuidanceProblemWriter } from "../../semp/guidanceProblemWriter.js";
import { guidanceProblemKey } from "../../semp/sourceProblemKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { agentGuidanceDriftFindingsStore } from "../agentGuidanceDriftFindingsStore.js";
import { resolveGuidanceDriftFinding } from "../resolveGuidanceDriftFinding.js";

/**
 * Every path that ends a guidance drift finding closes its `guidanceDrift` problem in the same transaction
 * (issue #1915): the owner's decision (allow, forbid, dismiss) and the emptying of the project's guidance. The
 * drift passes' own resolves are covered with the real composition in `sempProblemsRecovery.test.ts`.
 */

class RollbackSentinel extends Error {}

let admin: Pool;
let pool: Pool;
let tenant: string;
let user: string;
let project: string;

const sections = { purpose: "Purpose", allowed: "Existing", notAllowed: "", generalInstructions: "" };
const emptySections = { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" };
const behaviorPayload = {
  kind: "behavior" as const,
  subject: { mcpTool: "search", databaseId: null },
  claim: "Claim",
  evidence: { runIds: ["one", "two", "three"], count: 3 },
  suggestedAllowedLine: "Create tasks from new GitHub issues.",
  suggestedNotAllowedLine: "Do not create tasks.",
  severity: "warning" as const,
};
const permissionPayload = {
  kind: "permission" as const,
  subject: { operation: "item.create", databaseId: null },
  claim: "Claim",
  guidanceExcerpt: "Excerpt",
  manifestFacts: ["Fact"],
  severity: "warning" as const,
};

/** The state of the problems of the tenant by dedupe key: `active`, or the resolution kind. */
async function problemStates(): Promise<Record<string, string>> {
  const { rows } = await admin.query<{ dedupe_key: string; resolved_at: Date | null; resolution_kind: string | null }>(
    "SELECT dedupe_key, resolved_at, resolution_kind FROM semp_problems WHERE tenant_id = $1",
    [tenant],
  );
  return Object.fromEntries(
    rows.map((row) => [row.dedupe_key, row.resolved_at === null ? "active" : (row.resolution_kind ?? "resolved")]),
  );
}

/** An active finding with the active problem the drift run raised for it. */
async function raiseFinding(
  fingerprint: string,
  payload: typeof behaviorPayload | typeof permissionPayload,
  projectItemId = project,
) {
  return withTransaction(pool, async (tx) => {
    const { finding } = await agentGuidanceDriftFindingsStore.upsertActive(tx, {
      projectItemId,
      fingerprint,
      payload,
      seenAt: new Date("2026-01-01T00:00:00Z"),
    });
    await createGuidanceProblemWriter().raise(tx, {
      userId: user,
      projectItemId,
      fingerprint,
      findingId: finding.id,
      occurrenceKey: `${fingerprint}:1`,
    });
    return finding;
  });
}

async function createProject(name: string): Promise<string> {
  const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
  if (!db.rows[0]) throw new Error("Missing projects");
  return (await createChokePoint(pool).createItem({ databaseId: db.rows[0].id, properties: { name } })).id;
}

const saveInitialGuidance = () =>
  withTransaction(pool, (tx) =>
    saveGuidanceSections(tx, { actorUserId: user, projectItemId: project, sections, expectedUpdatedAt: null }),
  );

describe("the problem of a guidance drift finding closes when the finding ends (issue #1915)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    user = (
      await createUser(admin, { email: "owner@example.test", passwordHash: "hash", tenantId: tenant, locale: "en" })
    ).id;
    await runInTenant(tenant, () => seedSystem(pool));
    project = await runInTenant(tenant, () => createProject("Project"));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  describe("the owner's decision", () => {
    for (const choice of ["allow", "forbid", "dismiss"] as const) {
      it(`resolves the problem of a behavior finding the owner settles with ${choice}, and no other`, async () => {
        await runInTenant(tenant, async () => {
          const saved = await saveInitialGuidance();
          const finding = await raiseFinding("a".repeat(64), behaviorPayload);
          await raiseFinding("b".repeat(64), behaviorPayload);

          await withTransaction(pool, (tx) =>
            resolveGuidanceDriftFinding(tx, {
              findingId: finding.id,
              actorUserId: user,
              choice,
              expectedGuidanceUpdatedAt: saved.updatedAt,
            }),
          );

          expect(await problemStates()).toEqual({
            [guidanceProblemKey(project, "a".repeat(64))]: "recovered",
            [guidanceProblemKey(project, "b".repeat(64))]: "active",
          });
        });
      });
    }

    it("resolves the problem of a permission finding the owner dismisses", async () => {
      await runInTenant(tenant, async () => {
        const saved = await saveInitialGuidance();
        const finding = await raiseFinding("c".repeat(64), permissionPayload);

        await withTransaction(pool, (tx) =>
          resolveGuidanceDriftFinding(tx, {
            findingId: finding.id,
            actorUserId: user,
            choice: "dismiss",
            expectedGuidanceUpdatedAt: saved.updatedAt,
          }),
        );

        expect(await problemStates()).toEqual({ [guidanceProblemKey(project, "c".repeat(64))]: "recovered" });
      });
    });

    it("keeps the problem active, and the finding active, when the decision rolls back", async () => {
      await runInTenant(tenant, async () => {
        const saved = await saveInitialGuidance();
        const finding = await raiseFinding("d".repeat(64), behaviorPayload);

        await expect(
          withTransaction(pool, async (tx) => {
            await resolveGuidanceDriftFinding(tx, {
              findingId: finding.id,
              actorUserId: user,
              choice: "allow",
              expectedGuidanceUpdatedAt: saved.updatedAt,
            });
            throw new RollbackSentinel();
          }),
        ).rejects.toBeInstanceOf(RollbackSentinel);

        expect(await problemStates()).toEqual({ [guidanceProblemKey(project, "d".repeat(64))]: "active" });
        const { rows } = await admin.query<{ status: string }>(
          "SELECT status FROM agent_guidance_drift_findings WHERE id = $1",
          [finding.id],
        );
        expect(rows).toEqual([{ status: "active" }]);
      });
    });

    it("keeps the problem active when the decision is refused", async () => {
      await runInTenant(tenant, async () => {
        const saved = await saveInitialGuidance();
        const finding = await raiseFinding("e".repeat(64), permissionPayload);

        // A permission finding has no allow or forbid line, so the choice is refused before anything is written.
        await expect(
          withTransaction(pool, (tx) =>
            resolveGuidanceDriftFinding(tx, {
              findingId: finding.id,
              actorUserId: user,
              choice: "allow",
              expectedGuidanceUpdatedAt: saved.updatedAt,
            }),
          ),
        ).rejects.toMatchObject({ details: { reason: "not_applicable" } });

        expect(await problemStates()).toEqual({ [guidanceProblemKey(project, "e".repeat(64))]: "active" });
      });
    });

    it("leaves the problem resolved when the settled finding is reported again, because it is never reactivated", async () => {
      await runInTenant(tenant, async () => {
        const saved = await saveInitialGuidance();
        const finding = await raiseFinding("f".repeat(64), behaviorPayload);
        await withTransaction(pool, (tx) =>
          resolveGuidanceDriftFinding(tx, {
            findingId: finding.id,
            actorUserId: user,
            choice: "dismiss",
            expectedGuidanceUpdatedAt: saved.updatedAt,
          }),
        );

        const again = await withTransaction(pool, (tx) =>
          agentGuidanceDriftFindingsStore.upsertActive(tx, {
            projectItemId: project,
            fingerprint: "f".repeat(64),
            payload: behaviorPayload,
            seenAt: new Date("2026-01-02T00:00:00Z"),
          }),
        );

        expect(again.transitionedToActive).toBe(false);
        expect(await problemStates()).toEqual({ [guidanceProblemKey(project, "f".repeat(64))]: "recovered" });
      });
    });
  });

  describe("emptying the guidance of the project", () => {
    it("resolves the problem of every active finding and leaves the problem of another project active", async () => {
      await runInTenant(tenant, async () => {
        const saved = await saveInitialGuidance();
        await raiseFinding("1".repeat(64), behaviorPayload);
        await raiseFinding("2".repeat(64), permissionPayload);
        const otherProject = await createProject("Other project");
        await raiseFinding("3".repeat(64), behaviorPayload, otherProject);

        await withTransaction(pool, (tx) =>
          saveGuidanceSections(tx, {
            actorUserId: user,
            projectItemId: project,
            sections: emptySections,
            expectedUpdatedAt: saved.updatedAt,
          }),
        );

        const states = await problemStates();
        expect(states[guidanceProblemKey(project, "1".repeat(64))]).toBe("recovered");
        expect(states[guidanceProblemKey(project, "2".repeat(64))]).toBe("recovered");
        expect(states[guidanceProblemKey(otherProject, "3".repeat(64))]).toBe("active");
        const { rows } = await admin.query<{ status: string }>(
          "SELECT status FROM agent_guidance_drift_findings WHERE project_item_id = $1 ORDER BY fingerprint",
          [project],
        );
        expect(rows).toEqual([{ status: "resolved" }, { status: "resolved" }]);
      });
    });

    it("keeps the problems active when the emptying rolls back", async () => {
      await runInTenant(tenant, async () => {
        const saved = await saveInitialGuidance();
        await raiseFinding("4".repeat(64), behaviorPayload);

        await expect(
          withTransaction(pool, async (tx) => {
            await saveGuidanceSections(tx, {
              actorUserId: user,
              projectItemId: project,
              sections: emptySections,
              expectedUpdatedAt: saved.updatedAt,
            });
            throw new RollbackSentinel();
          }),
        ).rejects.toBeInstanceOf(RollbackSentinel);

        expect(await problemStates()).toEqual({ [guidanceProblemKey(project, "4".repeat(64))]: "active" });
      });
    });
  });
});
