import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  loadFullModuleRegistry,
  seedSystem,
  type ChokePoint,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { GENERIC_OPERATION_NAMES } from "@semprec/shared";
import {
  createGenericOperationAgentTools,
  listGrantedGenericOperationAgentTools,
} from "../tools/generic/genericOperationAgentTools.js";

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry: ModuleRegistry = await loadFullModuleRegistry();

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`${randomUUID()}@example.com`],
  );
  return rows[0]!.id;
}

async function projectsDatabaseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'projects'`);
  if (!rows[0]) throw new Error("Projects database was not seeded");
  return rows[0].id;
}

async function createProjectItem(): Promise<string> {
  const projectsDbId = await projectsDatabaseId();
  const item = await chokePoint.createItem({ databaseId: projectsDbId, properties: {} });
  return item.id;
}

function parseSuccess<T>(outcome: { error: boolean; result: string }): T {
  expect(outcome.error).toBe(false);
  return JSON.parse(outcome.result) as T;
}

describe("generic operation AgentTools (issue #220)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("createGenericOperationAgentTools", () => {
    it("returns owner_violation, never touching the choke point, for a currentRunId that doesn't exist", async () => {
      const tools = createGenericOperationAgentTools(pool);

      const outcome = await tools["item.get"](randomUUID(), { itemId: randomUUID() });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^owner_violation:/);
    });

    it("returns owner_violation for a run whose project_item_id is NULL", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no project" });
      const tools = createGenericOperationAgentTools(pool);

      const outcome = await tools["item.get"](run.id, { itemId: randomUUID() });

      expect(outcome.error).toBe(true);
      expect(outcome.result).toMatch(/^owner_violation:/);
    });

    it("derives the actor exclusively from the persisted run — a spoofed identity-shaped field in args is rejected, and a legitimate call attributes the write to the run's own project", async () => {
      const projectItemId = await createProjectItem();
      const otherProjectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "make a view" });
      const database = await chokePoint.createDatabase({ name: "Tools DB" });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);

      // Every generic-operation input schema is a strict zod object with none of these field
      // names (see AuthenticatedActor's own doc comment) — an attempt to smuggle a different
      // identity in through `args` fails validation rather than silently being ignored.
      const spoofed = await tools["view.create"](run.id, {
        databaseId: database.id,
        type: "table",
        name: "Stolen view",
        agentProjectItemId: otherProjectItemId,
        runId: randomUUID(),
        userId: randomUUID(),
      });
      expect(spoofed.error).toBe(true);

      const legit = await tools["view.create"](run.id, {
        databaseId: database.id,
        type: "table",
        name: "Legit view",
      });
      const view = parseSuccess<{ id: string; creatorProjectItemId: string | null }>(legit);
      expect(view.creatorProjectItemId).toBe(projectItemId);
      expect(view.creatorProjectItemId).not.toBe(otherProjectItemId);
    });

    it("a destructive operation, granted, returns a synthetic-success result and creates exactly one pending approval request, without executing", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "delete a view" });
      const view = await chokePoint.createView({ type: "list", name: "Scratch", config: { membership: "manual" } });
      const tools = createGenericOperationAgentTools(pool, moduleRegistry);

      const outcome = await tools["view.delete"](run.id, { viewId: view.id });

      expect(outcome.error).toBe(false);
      expect(outcome.result).toContain("requires human approval");

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM approval_requests WHERE agent_run_id = $1`,
        [run.id],
      );
      expect(rows[0]!.count).toBe(1);
      expect(await chokePoint.getView(view.id)).not.toBeNull();
    });
  });

  describe("listGrantedGenericOperationAgentTools", () => {
    it("returns [] for a run with no project context", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no project" });

      const granted = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id);

      expect(granted).toEqual([]);
    });

    it("returns [] when no moduleRegistry is supplied — an ungranted operation is absent, never present-but-forbidden", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check tools" });

      const granted = await listGrantedGenericOperationAgentTools(pool, undefined, run.id);

      expect(granted).toEqual([]);
    });

    it("returns every operation once every generic-operation capability is granted", async () => {
      const projectItemId = await createProjectItem();
      const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "check tools" });

      const granted = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, run.id);

      expect(granted.sort()).toEqual([...GENERIC_OPERATION_NAMES].sort());
    });
  });
});
