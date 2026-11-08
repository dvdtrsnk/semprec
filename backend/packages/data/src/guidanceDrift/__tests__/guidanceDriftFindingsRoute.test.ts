import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  fingerprintGuidanceDriftSubject,
  runAsSystem,
  runInTenant,
  type GuidanceDriftContradiction,
  type GuidanceDriftSubject,
} from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { createProjectAgentGuidanceSaveRouteHandler } from "../../projectAgentGuidance/projectAgentGuidanceRouteHandlers.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { agentGuidanceDriftFindingsStore } from "../agentGuidanceDriftFindingsStore.js";
import { createProjectGuidanceDriftReadRouteHandler } from "../guidanceDriftFindingsRouteHandlers.js";

let admin: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
let projectA: string;
let projectB: string;
let taskA: string;

const RUN_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function behaviorPayload(mcpTool: string): GuidanceDriftContradiction {
  return {
    kind: "behavior",
    subject: { mcpTool, databaseId: null },
    claim: `The agent keeps calling ${mcpTool}`,
    evidence: { runIds: RUN_IDS, count: 3 },
    suggestedAllowedLine: `Calling ${mcpTool} is allowed`,
    suggestedNotAllowedLine: `Do not call ${mcpTool}`,
    severity: "warning",
  };
}

function permissionPayload(operation: string): GuidanceDriftContradiction {
  return {
    kind: "permission",
    subject: { operation, databaseId: null },
    claim: `Guidance allows ${operation}`,
    guidanceExcerpt: "You may delete any task",
    manifestFacts: [`${operation} is not granted`, "Only reads are granted"],
    severity: "blocking",
  };
}

async function seedFinding(tenant: string, projectItemId: string, payload: GuidanceDriftContradiction, seenAt: Date) {
  const subject: GuidanceDriftSubject | null = payload.subject;
  if (subject === null) throw new Error("fixture payloads always carry a subject");
  return runInTenant(tenant, () =>
    withTransaction(pool, async (tx) => {
      const result = await agentGuidanceDriftFindingsStore.upsertActive(tx, {
        projectItemId,
        fingerprint: fingerprintGuidanceDriftSubject(projectItemId, payload.kind, subject),
        payload,
        seenAt,
      });
      return result.finding.id;
    }),
  );
}

async function moduleItem(tenant: string, moduleId: string): Promise<string> {
  return runInTenant(tenant, async () => {
    const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
    const databaseId = db.rows[0]?.id;
    if (!databaseId) throw new Error(`Missing ${moduleId}`);
    return (await createChokePoint(pool).createItem({ databaseId, properties: { name: moduleId } })).id;
  });
}

const read = (projectItemId: string) =>
  createProjectGuidanceDriftReadRouteHandler(pool)({ params: { id: projectItemId } });

/** Saves guidance through the real save route (saving never resolves findings) and returns its version. */
async function saveGuidance(tenant: string, projectItemId: string, userId: string): Promise<string> {
  await runInTenant(tenant, () =>
    createProjectAgentGuidanceSaveRouteHandler(pool)({
      params: { id: projectItemId },
      identity: { user: { id: userId } },
      body: {
        sections: { purpose: "Coordinate", allowed: "Read", notAllowed: "", generalInstructions: "" },
        expectedUpdatedAt: null,
      },
    }),
  );
  const guidance = await runInTenant(tenant, () =>
    withTransaction(pool, (tx) => projectAgentGuidanceStore.load(tx, projectItemId)),
  );
  if (!guidance) throw new Error("Guidance was not saved");
  return guidance.updatedAt;
}

describe("GET /api/projects/:id/agent-guidance/drift (issue #1630)", () => {
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
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    userA = (await createUser(admin, { email: "a@example.test", passwordHash: "hash", tenantId: tenantA })).id;
    userB = (await createUser(admin, { email: "b@example.test", passwordHash: "hash", tenantId: tenantB })).id;
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(pool));
    projectA = await moduleItem(tenantA, "projects");
    projectB = await moduleItem(tenantB, "projects");
    taskA = await moduleItem(tenantA, "tasks");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("answers 200 with no guidance version and an empty list for a project without guidance or findings", async () => {
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(result).toEqual({ status: 200, body: { guidanceUpdatedAt: null, findings: [] } });
  });

  it("answers the current guidance version and an empty list when guidance exists but nothing drifted", async () => {
    await runInTenant(tenantA, () =>
      createProjectAgentGuidanceSaveRouteHandler(pool)({
        params: { id: projectA },
        identity: { user: { id: userA } },
        body: {
          sections: { purpose: "Coordinate", allowed: "Read", notAllowed: "", generalInstructions: "" },
          expectedUpdatedAt: null,
        },
      }),
    );
    const guidance = await runInTenant(tenantA, () =>
      withTransaction(pool, (tx) => projectAgentGuidanceStore.load(tx, projectA)),
    );
    expect(guidance?.updatedAt).toEqual(expect.any(String));
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(result).toEqual({ status: 200, body: { guidanceUpdatedAt: guidance?.updatedAt, findings: [] } });
  });

  it("answers an empty list without guidance even with an active finding, and lists it once guidance is saved (R1 F4)", async () => {
    // An active finding without guidance: the drift producer can insert one while a concurrent delete
    // of the guidance resolves the findings it saw (R1 F4).
    const id = await seedFinding(tenantA, projectA, behaviorPayload("tool_mixed"), new Date("2026-10-17T08:00:00Z"));
    expect(await runInTenant(tenantA, () => read(projectA))).toEqual({
      status: 200,
      body: { guidanceUpdatedAt: null, findings: [] },
    });
    const updatedAt = await saveGuidance(tenantA, projectA, userA);
    const after = await runInTenant(tenantA, () => read(projectA));
    expect(after.body.guidanceUpdatedAt).toBe(updatedAt);
    expect(after.body.findings.map((finding) => finding.id)).toEqual([id]);
  });

  it("returns an active behavior finding with its three runs and both suggested lines", async () => {
    await saveGuidance(tenantA, projectA, userA);
    const seenAt = new Date("2026-10-10T09:00:00.000Z");
    const id = await seedFinding(tenantA, projectA, behaviorPayload("tasks_delete"), seenAt);
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(result.body.findings).toEqual([
      {
        id,
        kind: "behavior",
        claim: "The agent keeps calling tasks_delete",
        severity: "warning",
        firstSeenAt: seenAt.toISOString(),
        evidence: { runIds: RUN_IDS, count: 3 },
        suggestedAllowedLine: "Calling tasks_delete is allowed",
        suggestedNotAllowedLine: "Do not call tasks_delete",
      },
    ]);
  });

  it("returns an active permission finding with excerpt and manifest facts and no suggestions", async () => {
    await saveGuidance(tenantA, projectA, userA);
    const seenAt = new Date("2026-10-11T09:00:00.000Z");
    const id = await seedFinding(tenantA, projectA, permissionPayload("items.delete"), seenAt);
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(result.body.findings).toEqual([
      {
        id,
        kind: "permission",
        claim: "Guidance allows items.delete",
        severity: "blocking",
        firstSeenAt: seenAt.toISOString(),
        evidence: {
          guidanceExcerpt: "You may delete any task",
          manifestFacts: ["items.delete is not granted", "Only reads are granted"],
        },
        suggestedAllowedLine: null,
        suggestedNotAllowedLine: null,
      },
    ]);
  });

  it("lists findings oldest first by firstSeenAt, breaking a tie by id", async () => {
    await saveGuidance(tenantA, projectA, userA);
    const later = new Date("2026-10-12T10:00:00.000Z");
    const earlier = new Date("2026-10-12T08:00:00.000Z");
    const tieA = await seedFinding(tenantA, projectA, behaviorPayload("tool_a"), later);
    const oldest = await seedFinding(tenantA, projectA, permissionPayload("items.update"), earlier);
    const tieB = await seedFinding(tenantA, projectA, behaviorPayload("tool_b"), later);
    const tied = [tieA, tieB].sort();
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(result.body.findings.map((finding) => finding.id)).toEqual([oldest, ...tied]);
    expect(result.body.findings.map((finding) => finding.firstSeenAt)).toEqual([
      earlier.toISOString(),
      later.toISOString(),
      later.toISOString(),
    ]);
  });

  it("leaves a resolved finding out of the list", async () => {
    await saveGuidance(tenantA, projectA, userA);
    const kept = await seedFinding(tenantA, projectA, behaviorPayload("tool_kept"), new Date("2026-10-13T08:00:00Z"));
    const resolved = await seedFinding(
      tenantA,
      projectA,
      permissionPayload("items.create"),
      new Date("2026-10-13T07:00:00Z"),
    );
    await runInTenant(tenantA, () =>
      withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.resolve(tx, resolved, new Date("2026-10-13T09:00:00Z")),
      ),
    );
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(result.body.findings.map((finding) => finding.id)).toEqual([kept]);
  });

  it("refuses a non-UUID id with validation_failed before reading anything", async () => {
    const listActive = vi.spyOn(agentGuidanceDriftFindingsStore, "listActive");
    const failure = runInTenant(tenantA, () => read("not-a-uuid"));
    await expect(failure).rejects.toBeInstanceOf(ValidationError);
    await expect(failure).rejects.toMatchObject({ code: "validation_failed", details: { field: "id" } });
    expect(listActive).not.toHaveBeenCalled();
  });

  it("answers not_found for an unknown id and for an item outside the Projects database", async () => {
    await seedFinding(tenantA, projectA, behaviorPayload("tool_x"), new Date("2026-10-14T08:00:00Z"));
    for (const id of ["0b9c1d4e-3f2a-4b5c-8d6e-7f8091a2b3c4", taskA]) {
      const failure = runInTenant(tenantA, () => read(id));
      await expect(failure).rejects.toBeInstanceOf(NotFoundError);
      await expect(failure).rejects.toMatchObject({ code: "not_found", message: "Project not found" });
    }
  });

  it("answers another tenant's project id exactly like a random id and leaks none of its findings", async () => {
    await saveGuidance(tenantA, projectA, userA);
    await saveGuidance(tenantB, projectB, userB);
    const foreignFinding = await seedFinding(
      tenantA,
      projectA,
      permissionPayload("items.delete"),
      new Date("2026-10-15T08:00:00Z"),
    );
    const ownFinding = await seedFinding(
      tenantB,
      projectB,
      behaviorPayload("tool_b"),
      new Date("2026-10-15T08:00:00Z"),
    );
    const own = await runInTenant(tenantB, () => read(projectB));
    expect(own.body.findings.map((finding) => finding.id)).toEqual([ownFinding]);
    const outcome = async (id: string) => {
      try {
        await runInTenant(tenantB, () => read(id));
        return { ok: true };
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        return { name: error.name, code: error.code, message: error.message, details: error.details ?? null };
      }
    };
    const foreign = await outcome(projectA);
    expect(foreign).toEqual(await outcome("5d0e4a1c-2b3f-4c6d-9e7f-8a9b0c1d2e3f"));
    expect(foreign).toMatchObject({ code: "not_found" });
    expect(JSON.stringify(foreign)).not.toContain(foreignFinding);
  });

  it("reads the guidance version and the findings from one REPEATABLE READ snapshot", async () => {
    await saveGuidance(tenantA, projectA, userA);
    const first = await seedFinding(tenantA, projectA, behaviorPayload("tool_first"), new Date("2026-10-16T08:00:00Z"));
    let concurrent: string | undefined;
    const load = projectAgentGuidanceStore.load.bind(projectAgentGuidanceStore);
    vi.spyOn(projectAgentGuidanceStore, "load").mockImplementation(async (tx, id) => {
      const guidance = await load(tx, id);
      // Committed by another connection after the snapshot was taken and before the findings read.
      concurrent = await seedFinding(
        tenantA,
        projectA,
        behaviorPayload("tool_concurrent"),
        new Date("2026-10-16T09:00:00Z"),
      );
      return guidance;
    });
    const result = await runInTenant(tenantA, () => read(projectA));
    expect(concurrent).toEqual(expect.any(String));
    expect(result.body.findings.map((finding) => finding.id)).toEqual([first]);
    vi.restoreAllMocks();
    const after = await runInTenant(tenantA, () => read(projectA));
    expect(after.body.findings.map((finding) => finding.id)).toEqual([first, concurrent]);
  });
});
