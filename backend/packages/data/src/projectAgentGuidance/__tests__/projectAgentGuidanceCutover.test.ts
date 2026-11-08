import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem } from "../../chokePoint/itemsStore.js";
import { withTransaction } from "../../db/pool.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { logger } from "../../tenancy/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { runProjectAgentGuidanceCutoverMigration } from "../projectAgentGuidanceCutoverMigration.js";

const ACCEPTANCE_TEXT = "Purpose: A\nAllowed: B\nNot allowed: C\nGeneral instructions: D";
const ACCEPTANCE_MARKDOWN = "## Purpose\nA\n\n## Allowed\nB\n\n## Not allowed\nC\n\n## General instructions\nD\n";

interface GuidanceRow {
  owner_user_id: string;
  markdown: string;
  updated_at: Date;
}

let pool: Pool;

/** The Projects database of the ambient scope, read through the given pool. */
async function projectsDatabaseId(queryPool: Pool): Promise<string> {
  return withTransaction(queryPool, async (client: PoolClient) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("the tenant has no Projects database");
    return database.id;
  });
}

/** Inserts a Projects item with the given properties through the store that seeds write with. */
async function createProject(queryPool: Pool, properties: Record<string, unknown>): Promise<string> {
  return withTransaction(queryPool, async (client) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("the tenant has no Projects database");
    return (await insertItem(client, { databaseId: database.id, properties })).id;
  });
}

async function createOwner(queryPool: Pool, tenantId = getTenantZeroId()): Promise<string> {
  const user = await createUser(queryPool, {
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
    tenantId,
    role: "admin",
  });
  return user.id;
}

async function guidanceRow(queryPool: Pool, projectItemId: string): Promise<GuidanceRow | undefined> {
  const { rows } = await queryPool.query<GuidanceRow>(
    "SELECT owner_user_id, markdown, updated_at FROM project_agent_guidance WHERE project_item_id = $1",
    [projectItemId],
  );
  return rows[0];
}

async function driftHeartbeatStates(queryPool: Pool, projectItemId: string): Promise<boolean[]> {
  const { rows } = await queryPool.query<{ enabled: boolean }>(
    "SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
    [projectItemId],
  );
  return rows.map((row) => row.enabled);
}

describe("runProjectAgentGuidanceCutoverMigration (issue #1449)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("writes the guidance row of a project from its agents text, owned by the tenant's user, with the drift heartbeat enabled", async () => {
    const ownerId = await createOwner(pool);
    const projectId = await createProject(pool, { name: "Atlas", agents: ACCEPTANCE_TEXT });

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect(await guidanceRow(pool, projectId)).toMatchObject({ owner_user_id: ownerId, markdown: ACCEPTANCE_MARKDOWN });
    expect(await driftHeartbeatStates(pool, projectId)).toEqual([true]);
  });

  it("writes an agents text with no label as the General instructions section only", async () => {
    await createOwner(pool);
    const projectId = await createProject(pool, { name: "Plain", agents: "Only a free-form note." });

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect((await guidanceRow(pool, projectId))?.markdown).toBe("## General instructions\nOnly a free-form note.\n");
  });

  it("changes no row on a second run, and none the user has edited", async () => {
    const ownerId = await createOwner(pool);
    const projectId = await createProject(pool, { name: "Atlas", agents: ACCEPTANCE_TEXT });
    await runProjectAgentGuidanceCutoverMigration(pool);
    const firstRun = await guidanceRow(pool, projectId);

    await runProjectAgentGuidanceCutoverMigration(pool);
    expect(await guidanceRow(pool, projectId)).toEqual(firstRun);

    const edited = "## Purpose\nedited by the user\n";
    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, { projectItemId: projectId, ownerUserId: ownerId, markdown: edited }),
    );
    await runProjectAgentGuidanceCutoverMigration(pool);

    expect((await guidanceRow(pool, projectId))?.markdown).toBe(edited);
    expect(await driftHeartbeatStates(pool, projectId)).toEqual([true]);
  });

  it("writes nothing for a tenant without a user, and resolves", async () => {
    const projectId = await createProject(pool, { name: "Atlas", agents: ACCEPTANCE_TEXT });

    await expect(runProjectAgentGuidanceCutoverMigration(pool)).resolves.toBeUndefined();

    expect(await guidanceRow(pool, projectId)).toBeUndefined();
  });

  it("writes nothing for a tenant without a Projects database, and resolves", async () => {
    await resetDatabase(pool);
    await createOwner(pool);

    await expect(runProjectAgentGuidanceCutoverMigration(pool)).resolves.toBeUndefined();

    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM project_agent_guidance");
    expect(rows[0]?.n).toBe(0);
  });

  it("skips a deleted Projects item", async () => {
    await createOwner(pool);
    const projectId = await createProject(pool, { name: "Trashed", agents: ACCEPTANCE_TEXT });
    const databaseId = await projectsDatabaseId(pool);
    await withTransaction(pool, (client) => softDeleteItem(client, databaseId, projectId));

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect(await guidanceRow(pool, projectId)).toBeUndefined();
  });

  it("skips a Projects item whose agents text is blank", async () => {
    await createOwner(pool);
    const projectId = await createProject(pool, { name: "Blank", agents: "   \n\t" });

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect(await guidanceRow(pool, projectId)).toBeUndefined();
  });

  it("skips a Projects item whose agents value is not text", async () => {
    await createOwner(pool);
    const projectId = await createProject(pool, { name: "Numeric", agents: 42 });

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect(await guidanceRow(pool, projectId)).toBeUndefined();
  });

  it("writes no row for an agents text whose labels carry no content", async () => {
    await createOwner(pool);
    const projectId = await createProject(pool, { name: "Labels", agents: "Purpose:\nAllowed:" });

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect(await guidanceRow(pool, projectId)).toBeUndefined();
    expect(await driftHeartbeatStates(pool, projectId)).toEqual([]);
  });

  it("skips a document above the size limit and warns with the tenant and project ids only", async () => {
    await createOwner(pool);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const oversized = `General instructions: ${"x".repeat(MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES)}`;
    const projectId = await createProject(pool, { name: "Huge", agents: oversized });

    await runProjectAgentGuidanceCutoverMigration(pool);

    expect(await guidanceRow(pool, projectId)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { tenantId: getTenantZeroId(), projectItemId: projectId },
      "project_agent_guidance_too_large",
    );
  });

  it("never writes tenant A's guidance under tenant B's scope", async () => {
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const ownerA = await createOwner(pool, getTenantZeroId());
      const projectA = await createProject(pool, { name: "Atlas", agents: "Purpose: from tenant A" });

      const tenantB = await createTestTenant(pool);
      const ownerB = await createOwner(pool, tenantB);
      await runInTenant(tenantB, () => seedSystem(dataPool));
      const projectB = await runInTenant(tenantB, () =>
        withTransaction(dataPool, async (client) => {
          const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
          if (!database) throw new Error("tenant B has no Projects database");
          return (
            await insertItem(client, {
              databaseId: database.id,
              properties: { name: "Bravo", agents: "Purpose: from tenant B" },
            })
          ).id;
        }),
      );

      await runInTenant(tenantB, () => runProjectAgentGuidanceCutoverMigration(dataPool));
      expect(await guidanceRow(pool, projectB)).toMatchObject({ owner_user_id: ownerB });
      expect(await guidanceRow(pool, projectA)).toBeUndefined();

      await runInTenant(getTenantZeroId(), () => runProjectAgentGuidanceCutoverMigration(dataPool));
      expect(await guidanceRow(pool, projectA)).toMatchObject({ owner_user_id: ownerA });
    } finally {
      await dataPool.end();
    }
  });
});
