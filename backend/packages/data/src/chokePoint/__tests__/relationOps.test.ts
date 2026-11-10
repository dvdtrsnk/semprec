import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createTestProjectItem, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant } from "../../testSupport/tenantFixtures.js";
import { createViewTypeRegistry } from "../viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { CardinalityViolationError, ForbiddenError, ValidationError } from "../../errors.js";
import { createItemWithClient } from "../itemWrites.js";
import * as itemsStore from "../itemsStore.js";
import * as propertiesStore from "../propertiesStore.js";
import { assertRelationTargetLinkableWithClient, createRelationWithClient } from "../relationOps.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function propertyId(moduleId: string, key: string): Promise<string> {
  const databaseId = await databaseIdFor(moduleId);
  return withTransaction(pool, async (client) => {
    const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
    if (!property) throw new Error(`No property '${key}' on '${moduleId}'`);
    return property.id;
  });
}

async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  const databaseId = await databaseIdFor(moduleId);
  return withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id);
}

async function checkTarget(relationPropertyId: string, targetItemId: string): Promise<void> {
  await withTransaction(pool, (client) =>
    assertRelationTargetLinkableWithClient(client, { relationPropertyId, targetItemId }),
  );
}

describe("assertRelationTargetLinkableWithClient (issue #1426)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("accepts a live project, including one with status done", async () => {
    const project = await createItem("projects", { name: "Active" });
    const done = await createItem("projects", { name: "Late invoice", status: "done" });
    const taskProject = await propertyId("tasks", "project");

    await expect(checkTarget(taskProject, project)).resolves.toBeUndefined();
    await expect(checkTarget(taskProject, done)).resolves.toBeUndefined();
  });

  it("reports a deleted target as targetDeleted on the relation key", async () => {
    const project = await createItem("projects", { name: "Gone" });
    await withTransaction(pool, async (client) => {
      await itemsStore.softDeleteItem(client, await databaseIdFor("projects"), project);
    });

    const error = await checkTarget(await propertyId("tasks", "project"), project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(400);
    expect((error as ValidationError).details).toEqual({ field: "project", code: "targetDeleted" });
  });

  it("reports an archived project as targetArchived", async () => {
    const project = await createItem("projects", { name: "Old", status: "archived" });

    const error = await checkTarget(await propertyId("tasks", "project"), project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toEqual({ field: "project", code: "targetArchived" });
  });

  it("reports a nonexistent target with the relation key as field", async () => {
    const error = await checkTarget(await propertyId("tasks", "project"), "00000000-0000-4000-8000-000000000001").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toMatchObject({ field: "project" });
  });

  it("rejects a malformed target UUID as validation on the relation key", async () => {
    const error = await checkTarget(await propertyId("tasks", "project"), "not-a-uuid").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) throw error;
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ field: "project" });
  });

  it("treats another tenant's item as nonexistent", async () => {
    const otherTenant = await createTestTenant(pool);
    // A runtime-role pool, because the superuser pool bypasses row-level security and would find tenant zero's Projects database.
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const foreignProject = await runInTenant(otherTenant, () => createTestProjectItem(runtimePool)).finally(() =>
      runtimePool.end(),
    );

    const error = await checkTarget(await propertyId("tasks", "project"), foreignProject).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toMatchObject({ field: "project", code: "targetNotFound" });
  });

  it("reports a one-to-one target that already holds its edge as a cardinality violation", async () => {
    const companyProperty = await propertyId("areas", "company");
    const company = await createItem("companies", { name: "Acme" });
    const area = await createItem("areas", { name: "Work" });
    await withTransaction(pool, (client) =>
      createRelationWithClient(client, {
        relationPropertyId: companyProperty,
        callerItemId: area,
        targetItemId: company,
      }),
    );

    const error = await checkTarget(companyProperty, company).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CardinalityViolationError);
    expect((error as CardinalityViolationError).details).toMatchObject({ field: "company" });
    await expect(
      checkTarget(companyProperty, await createItem("companies", { name: "Free" })),
    ).resolves.toBeUndefined();
  });

  it("reports a one-to-many target on the single-valued side, but not on the many side", async () => {
    const project = await createItem("projects", { name: "P" });
    const task = await createItem("tasks", { name: "T" });
    await withTransaction(pool, async (client) =>
      createRelationWithClient(client, {
        relationPropertyId: await propertyId("tasks", "project"),
        callerItemId: task,
        targetItemId: project,
      }),
    );

    // Projects.tasks is side A: the proposed project would be linked to a task that already has a project.
    const error = await checkTarget(await propertyId("projects", "tasks"), task).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CardinalityViolationError);
    // Tasks.project: a project may keep gaining tasks.
    await expect(checkTarget(await propertyId("tasks", "project"), project)).resolves.toBeUndefined();
  });

  it("rejects a system-owned relation property for a public caller", async () => {
    const proposalsProperty = await propertyId("processingProposals", "sourceInbox");

    // The ownership check runs before the target is looked up, so any id reaches it.
    const error = await checkTarget(proposalsProperty, "00000000-0000-4000-8000-000000000002").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).code).toBe("owner_violation");
  });
});
