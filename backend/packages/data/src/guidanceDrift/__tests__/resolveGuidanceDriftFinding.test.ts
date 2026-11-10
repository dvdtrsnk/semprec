import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { loadGuidanceSections, saveGuidanceSections } from "../../projectAgentGuidance/projectAgentGuidanceSections.js";
import { agentGuidanceDriftFindingsStore } from "../agentGuidanceDriftFindingsStore.js";
import { createResolveGuidanceDriftFindingRouteHandler } from "../guidanceDriftFindingsRouteHandlers.js";

type GuidanceActorRecord = {
  label: string;
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
  timedOut: boolean;
  consumed: boolean;
  primary?: { error: unknown };
};
const pendingGuidanceActors = new Set<Promise<unknown>>();
const guidanceActorRecords = new Map<Promise<unknown>, GuidanceActorRecord>();
function trackGuidanceActor<T>(actor: Promise<T>): Promise<T> {
  const record: GuidanceActorRecord = {
    label: `guidance actor ${guidanceActorRecords.size + 1}`,
    status: "pending",
    timedOut: false,
    consumed: false,
  };
  guidanceActorRecords.set(actor, record);
  pendingGuidanceActors.add(actor);
  void actor.then(
    (value) => {
      record.status = "fulfilled";
      record.value = value;
      pendingGuidanceActors.delete(actor);
    },
    (error: unknown) => {
      record.status = "rejected";
      record.error = error;
      pendingGuidanceActors.delete(actor);
    },
  );
  return actor;
}
function guidanceActorDiagnostic(): AggregateError | undefined {
  const retained = [...guidanceActorRecords.values()].filter(
    (record) => record.timedOut || record.status === "pending",
  );
  if (!retained.length) return undefined;
  const details: unknown[] = [];
  const primaries = new Set<{ error: unknown }>();
  for (const record of retained) {
    if (record.primary && !primaries.has(record.primary)) {
      primaries.add(record.primary);
      details.push(record.primary.error);
    }
    if (record.status === "pending") details.push(new Error(`${record.label} remains pending`));
    else if (record.status === "rejected" && !record.consumed) details.push(record.error);
    else if (
      typeof record.value === "object" &&
      record.value !== null &&
      "ok" in record.value &&
      record.value.ok === false &&
      !record.consumed &&
      "error" in record.value
    )
      details.push(record.value.error);
    else details.push(new Error(`${record.label} settled after its deadline`));
  }
  return new AggregateError(details, "Prior guidance actor crossed its deadline; resources remain reserved");
}
async function settleGuidanceActor<T>(actor: Promise<T>, primary?: { error: unknown }, deadlineMs = 5000): Promise<T> {
  if (!guidanceActorRecords.has(actor)) void trackGuidanceActor(actor);
  const record = guidanceActorRecords.get(actor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      actor,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (record) {
            record.timedOut = true;
            record.primary = primary;
          }
          reject(new Error("Guidance actor did not settle"));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type GuidanceOutcome = { ok: true } | { ok: false; error: unknown };
async function waitGuidanceReady<T>(
  ready: Promise<T>,
  actor: Promise<GuidanceOutcome>,
  message: string,
  deadlineMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      ready.then((value) => ({ kind: "ready" as const, value })),
      actor.then(
        (outcome) => ({ kind: "actor" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), deadlineMs);
      }),
    ]);
    if (winner.kind === "ready") return winner.value;
    const record = guidanceActorRecords.get(actor);
    if (winner.kind === "error") {
      if (record) record.consumed = true;
      throw winner.error;
    }
    if (!winner.outcome.ok) {
      if (record) record.consumed = true;
      throw winner.outcome.error;
    }
    throw new Error("Actor ended before readiness");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    const unsafe = guidanceActorDiagnostic();
    if (unsafe) throw unsafe;
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
    const unsafe = guidanceActorDiagnostic();
    if (unsafe) throw unsafe;
    await pool.end();
    await admin.end();
  });
  it("retains a guidance actor failure after readiness timeout", async () => {
    const never = new Promise<never>(() => {});
    type Outcome = { ok: true } | { ok: false; error: unknown };
    let finish: (value: Outcome) => void = () => {};
    const actor = trackGuidanceActor(
      new Promise<Outcome>((resolve) => {
        finish = resolve;
      }),
    );
    let finishPending: (value: Outcome) => void = () => {};
    const pendingActor = trackGuidanceActor(
      new Promise<Outcome>((resolve) => {
        finishPending = resolve;
      }),
    );
    let earlyActor: Promise<Outcome> | undefined;
    try {
      const timeout = await waitGuidanceReady(never, actor, "readiness timeout", 1).then(
        () => null,
        (error: unknown) => error,
      );
      expect(timeout).toMatchObject({ message: "readiness timeout" });
      const late = new Error("late guidance actor");
      finish({ ok: false, error: late });
      await actor;
      const outcome = await settleGuidanceActor(actor, { error: timeout }, 10);
      expect(outcome).toEqual({ ok: false, error: late });
      if (outcome.ok) throw new Error("Missing actor failure");
      const aggregate = new AggregateError([timeout, outcome.error], "finite settlement", { cause: timeout });
      expect(aggregate.cause).toBe(timeout);
      expect(aggregate.errors).toEqual([timeout, late]);
      expect(aggregate.errors[1]).toBe(late);
      expect(guidanceActorRecords.get(actor)?.consumed).toBe(false);

      const pendingTimeout = await waitGuidanceReady(never, pendingActor, "pending readiness timeout", 1).then(
        () => null,
        (error: unknown) => error,
      );
      await expect(settleGuidanceActor(pendingActor, { error: pendingTimeout }, 1)).rejects.toThrow();
      expect(guidanceActorDiagnostic()?.errors[0]).toBe(pendingTimeout);
      expect(pendingGuidanceActors.has(pendingActor)).toBe(true);
      const retained = new Error("retained guidance actor");
      finishPending({ ok: false, error: retained });
      await pendingActor;
      expect(guidanceActorDiagnostic()?.errors.find((error) => error === retained)).toBe(retained);
      const earlyError = new Error("early guidance actor");
      earlyActor = trackGuidanceActor(Promise.resolve<Outcome>({ ok: false, error: earlyError }));
      const early = await waitGuidanceReady(never, earlyActor, "unused deadline", 1).then(
        () => null,
        (error: unknown) => error,
      );
      expect(early).toBe(earlyError);
      expect(guidanceActorRecords.get(earlyActor)?.consumed).toBe(true);
      const earlyOutcome = await settleGuidanceActor(earlyActor, { error: timeout }, 10);
      const errors = [early];
      if (!earlyOutcome.ok && !guidanceActorRecords.get(earlyActor)?.consumed) errors.push(earlyOutcome.error);
      expect(errors).toEqual([earlyError]);
    } finally {
      finish({ ok: true });
      finishPending({ ok: true });
      await Promise.all([actor, pendingActor, earlyActor]);
      guidanceActorRecords.delete(actor);
      guidanceActorRecords.delete(pendingActor);
      if (earlyActor) guidanceActorRecords.delete(earlyActor);
    }
  });

  it("adds decision columns to populated historical rows in two tenants", async () => {
    const other = await createTestTenant(admin);
    const otherUser = await createUser(admin, { email: "other@example.test", passwordHash: "hash", tenantId: other });
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
    const nullFinding = await runInTenant(tenant, () =>
      withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "d".repeat(64),
          payload,
          seenAt: new Date("2026-01-01T00:00:00Z"),
        }),
      ),
    );
    const sql = await readFile(
      new URL("../../db/migrations/0145_guidance_drift_finding_decisions.sql", import.meta.url),
      "utf8",
    );
    const tenantFk = await readFile(
      new URL("../../db/migrations/0146_guidance_drift_resolved_by_tenant_fk.sql", import.meta.url),
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
        // Synthetic pre-0146 references use each tenant's existing owner.
        await client.query("UPDATE agent_guidance_drift_findings SET resolved_by = $2 WHERE id = $1", [ids[0], user]);
        await client.query("UPDATE agent_guidance_drift_findings SET resolved_by = $2 WHERE id = $1", [
          ids[1],
          otherUser.id,
        ]);
        await client.query(tenantFk);
      }),
    );
    for (const [scope, id, resolvedBy] of [
      [tenant, ids[0], user],
      [other, ids[1], otherUser.id],
      [tenant, nullFinding.finding.id, null],
    ] as const) {
      const result = await runInTenant(scope, () =>
        pool.query<{ id: string; status: string; resolved_by: string | null; resolution_choice: string | null }>(
          "SELECT id, status, resolved_by, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
          [id],
        ),
      );
      expect(result.rows).toEqual([{ id, status: "active", resolved_by: resolvedBy, resolution_choice: null }]);
    }
  });
  it("refuses a foreign resolved_by through the runtime role", async () => {
    const other = await createTestTenant(admin);
    const foreign = await createUser(admin, {
      email: "foreign@example.test",
      passwordHash: "hash",
      tenantId: other,
      locale: "en",
    });
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "f".repeat(64),
          payload,
          seenAt: new Date("2026-01-01T00:00:00Z"),
        }),
      ),
    );
    await expect(
      runInTenant(tenant, () =>
        pool.query("UPDATE agent_guidance_drift_findings SET resolved_by = $2 WHERE id = $1", [
          first.finding.id,
          foreign.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const after = await runInTenant(tenant, () =>
      pool.query<{ resolved_by: string | null }>(
        "SELECT resolved_by FROM agent_guidance_drift_findings WHERE id = $1",
        [first.finding.id],
      ),
    );
    expect(after.rows).toEqual([{ resolved_by: null }]);
  });
  it.each(["allow", "forbid"] as const)("rejects multiline %s suggestions without deciding", async (choice) => {
    await runInTenant(tenant, async () => {
      const saved = await withTransaction(pool, (tx) =>
        saveGuidanceSections(tx, {
          actorUserId: user,
          projectItemId: project,
          sections,
          expectedUpdatedAt: null,
        }),
      );
      const finding = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "7".repeat(64),
          seenAt: new Date("2026-01-01T00:00:00Z"),
          payload: {
            ...payload,
            suggestedAllowedLine: "Visible\n- extra",
            suggestedNotAllowedLine: "Visible\n- extra",
          },
        }),
      );
      const before = await pool.query<{ markdown: string; updated_at: Date }>(
        "SELECT markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
        [project],
      );
      await expect(
        createResolveGuidanceDriftFindingRouteHandler(pool)({
          params: { id: finding.finding.id },
          identity: { user: { id: user } },
          body: { choice, expectedGuidanceUpdatedAt: saved.updatedAt },
        }),
      ).rejects.toMatchObject({ status: 400 });
      const after = await pool.query<{ markdown: string; updated_at: Date }>(
        "SELECT markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
        [project],
      );
      expect(after.rows).toEqual(before.rows);
      expect(
        (
          await pool.query<{ status: string; resolution_choice: string | null }>(
            "SELECT status, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
            [finding.finding.id],
          )
        ).rows,
      ).toEqual([{ status: "active", resolution_choice: null }]);
      expect(
        (await pool.query("SELECT id FROM notifications WHERE source_id = $1", [finding.finding.id])).rows,
      ).toEqual([]);
    });
  });
  it("rolls back a guidance decision that would exceed the UTF-8 size cap", async () => {
    await runInTenant(tenant, async () => {
      const saved = await withTransaction(pool, (tx) =>
        saveGuidanceSections(tx, {
          actorUserId: user,
          projectItemId: project,
          sections,
          expectedUpdatedAt: null,
        }),
      );
      const finding = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "8".repeat(64),
          seenAt: new Date("2026-01-01T00:00:00Z"),
          payload: { ...payload, suggestedAllowedLine: "ž".repeat(16384) },
        }),
      );
      const before = await pool.query<{ markdown: string; updated_at: Date }>(
        "SELECT markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
        [project],
      );
      const jobs = await admin.query<{ id: string; key: string | null }>(
        "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
      );
      await expect(
        createResolveGuidanceDriftFindingRouteHandler(pool)({
          params: { id: finding.finding.id },
          identity: { user: { id: user } },
          body: { choice: "allow", expectedGuidanceUpdatedAt: saved.updatedAt },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        (
          await pool.query<{ markdown: string; updated_at: Date }>(
            "SELECT markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
            [project],
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await pool.query<{ status: string; resolution_choice: string | null }>(
            "SELECT status, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
            [finding.finding.id],
          )
        ).rows,
      ).toEqual([{ status: "active", resolution_choice: null }]);
      expect(
        (await pool.query("SELECT id FROM notifications WHERE source_id = $1", [finding.finding.id])).rows,
      ).toEqual([]);
      expect(
        (await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
          .rows,
      ).toEqual(jobs.rows);
    });
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
      const row = await pool.query<{
        status: string;
        resolved_by: string;
        resolution_choice: string;
        resolved_at: Date;
      }>(
        "SELECT status, resolved_by, resolution_choice, resolved_at FROM agent_guidance_drift_findings WHERE id = $1",
        [first.finding.id],
      );
      expect(row.rows).toEqual([
        {
          status: choice === "dismiss" ? "dismissed" : "resolved",
          resolved_by: user,
          resolution_choice: choice,
          resolved_at: expect.any(Date),
        },
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
      const beforeGuidance = await pool.query<{ markdown: string; updated_at: Date }>(
        "SELECT markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
        [project],
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
      const context = (actor: string, choice: "allow" | "forbid" | "dismiss", version: string | null) => ({
        params: { id: first.finding.id },
        identity: { user: { id: actor } },
        body: { choice, expectedGuidanceUpdatedAt: version },
      });
      const jobsBefore = await admin.query<{ id: string; key: string | null }>(
        "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
      );
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
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
        await expect(route(context(user, "forbid", saved.updatedAt))).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "choice", reason: "not_applicable" },
        });
      } finally {
        setInvalidationHook(() => {});
      }
      expect(
        (await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id"))
          .rows,
      ).toEqual(jobsBefore.rows);
      expect(events).toEqual([]);
      const unchanged = await pool.query<{ markdown: string; updated_at: Date }>(
        "SELECT markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
        [project],
      );
      expect(unchanged.rows).toEqual(beforeGuidance.rows);
      const rows = await pool.query<{ status: string; resolution_choice: string | null }>(
        "SELECT status, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
        [first.finding.id],
      );
      expect(rows.rows).toEqual([{ status: "active", resolution_choice: null }]);
      const notifications = await pool.query("SELECT id FROM notifications WHERE source_id = $1", [first.finding.id]);
      expect(notifications.rows).toEqual([]);
      expect((await route(context(user, "dismiss", saved.updatedAt))).status).toBe(200);
      await expect(route(context(user, "dismiss", saved.updatedAt))).rejects.toMatchObject({ status: 404 });
      await expect(
        route({
          params: { id: "00000000-0000-4000-8000-000000000000" },
          identity: { user: { id: user } },
          body: { choice: "dismiss", expectedGuidanceUpdatedAt: saved.updatedAt },
        }),
      ).rejects.toMatchObject({ status: 404 });
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

  it("returns a conflict without deciding when a concurrent guidance save wins", async () => {
    await runInTenant(tenant, async () => {
      const saved = await withTransaction(pool, (tx) =>
        saveGuidanceSections(tx, { actorUserId: user, projectItemId: project, sections, expectedUpdatedAt: null }),
      );
      const first = await withTransaction(pool, (tx) =>
        agentGuidanceDriftFindingsStore.upsertActive(tx, {
          projectItemId: project,
          fingerprint: "e".repeat(64),
          payload,
          seenAt: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      type Identity = { pid: number; started: string };
      let release = () => {};
      let holderReady: (identity: Identity) => void = () => {};
      let waiterReady: (pid: number) => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = new Promise<Identity>((resolve) => {
        holderReady = resolve;
      });
      const acquired = new Promise<number>((resolve) => {
        waiterReady = resolve;
      });
      const holder = trackGuidanceActor(
        withTransaction(pool, async (client) => {
          const identity = await client.query<Identity>(
            "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
          );
          if (!identity.rows[0]) throw new Error("Missing holder identity");
          const value = await saveGuidanceSections(client, {
            actorUserId: user,
            projectItemId: project,
            sections: { ...sections, purpose: "Concurrent save" },
            expectedUpdatedAt: saved.updatedAt,
          });
          holderReady(identity.rows[0]);
          await gate;
          return value;
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      let contender:
        | Promise<
            | { ok: true; value: Awaited<ReturnType<ReturnType<typeof createResolveGuidanceDriftFindingRouteHandler>>> }
            | { ok: false; error: unknown }
          >
        | undefined;
      const sqlstateFailures: unknown[] = [];
      let restoreQuery: (() => void) | undefined;
      const onAcquire = (client: PoolClient) => {
        const query = client.query.bind(client);
        const spy = vi.spyOn(client, "query");
        const forward = async (sql: string, values?: unknown[]) => {
          try {
            return await query(sql, values);
          } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "40001")
              sqlstateFailures.push(error);
            throw error;
          }
        };
        // The exercised calls use pg's promise overload.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        spy.mockImplementation(forward as typeof client.query);
        restoreQuery = () => spy.mockRestore();
        if (!("processID" in client) || typeof client.processID !== "number")
          throw new Error("Missing acquired backend PID");
        waiterReady(client.processID);
      };
      let failure: { error: unknown } | undefined;
      try {
        const owner = await waitGuidanceReady(held, holder, "Holder readiness timed out");
        pool.on("acquire", onAcquire);
        const route = createResolveGuidanceDriftFindingRouteHandler(pool);
        contender = trackGuidanceActor(
          route({
            params: { id: first.finding.id },
            identity: { user: { id: user } },
            body: { choice: "allow", expectedGuidanceUpdatedAt: saved.updatedAt },
          }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        const waiterPid = await waitGuidanceReady(acquired, contender, "Contender readiness timed out").finally(() => {
          pool.off("acquire", onAcquire);
        });
        const found = await admin.query<{ started: string }>(
          "SELECT backend_start::text AS started FROM pg_stat_activity WHERE pid = $1",
          [waiterPid],
        );
        if (!found.rows[0]) throw new Error("Contender backend missing");
        await expect
          .poll(
            async () => {
              const result = await admin.query<{ blocked: boolean }>(
                `SELECT EXISTS (SELECT 1 FROM pg_stat_activity h JOIN pg_stat_activity w ON w.pid = $3
            WHERE h.pid = $1 AND h.backend_start = $2::timestamptz AND w.backend_start = $4::timestamptz
              AND $1::int = ANY(pg_blocking_pids(w.pid))) AS blocked`,
                [owner.pid, owner.started, waiterPid, found.rows[0]?.started],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
      } catch (error) {
        failure = { error };
      }
      pool.off("acquire", onAcquire);
      release();
      const [ownerSettled, contenderSettled] = await Promise.allSettled([
        settleGuidanceActor(holder, failure),
        contender ? settleGuidanceActor(contender, failure) : Promise.resolve(undefined),
      ]);
      const actorErrors: unknown[] = [];
      const ownerResult = ownerSettled.status === "fulfilled" ? ownerSettled.value : undefined;
      const contenderResult = contenderSettled.status === "fulfilled" ? contenderSettled.value : undefined;
      if (ownerSettled.status === "rejected") actorErrors.push(ownerSettled.reason);
      else if (!ownerSettled.value.ok && !guidanceActorRecords.get(holder)?.consumed)
        actorErrors.push(ownerSettled.value.error);
      if (contenderSettled.status === "rejected") actorErrors.push(contenderSettled.reason);
      else if (
        contenderSettled.value &&
        !contenderSettled.value.ok &&
        contender &&
        !guidanceActorRecords.get(contender)?.consumed
      )
        actorErrors.push(contenderSettled.value.error);
      if (!pendingGuidanceActors.size) restoreQuery?.();
      if (failure && actorErrors.length)
        throw new AggregateError([failure.error, ...actorErrors], "Guidance overlap failed", { cause: failure.error });
      if (failure) throw failure.error;
      if (actorErrors.length) throw new AggregateError(actorErrors, "Guidance overlap actors failed");
      if (!ownerResult?.ok || !contenderResult?.ok) throw new Error("Missing overlap outcomes");
      expect(sqlstateFailures).toHaveLength(1);
      const currentDetails = await withTransaction(pool, (client) => loadGuidanceSections(client, project));
      expect(contenderResult.value).toEqual({
        status: 409,
        body: { error: { code: "version_conflict", details: { current: currentDetails } } },
      });
      const current = await pool.query<{ markdown: string }>(
        "SELECT markdown FROM project_agent_guidance WHERE project_item_id = $1",
        [project],
      );
      expect(current.rows[0]?.markdown).toContain("Concurrent save");
      expect(current.rows[0]?.markdown).not.toContain(payload.suggestedAllowedLine);
      const finding = await pool.query<{ status: string; resolution_choice: string | null }>(
        "SELECT status, resolution_choice FROM agent_guidance_drift_findings WHERE id = $1",
        [first.finding.id],
      );
      expect(finding.rows).toEqual([{ status: "active", resolution_choice: null }]);
      expect((await pool.query("SELECT id FROM notifications WHERE source_id = $1", [first.finding.id])).rows).toEqual(
        [],
      );
    });
  });
});
