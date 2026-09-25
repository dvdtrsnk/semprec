import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point relationPropertyOps", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creating a relation property against a non-existent targetDatabaseId is rejected, leaving no property or relation definition behind", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const bogusTargetId = randomUUID();

    await expect(
      chokePoint.createRelationProperty({
        sourceDatabaseId: db.id,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: bogusTargetId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const properties = await chokePoint.listProperties(db.id);
    expect(properties).toHaveLength(0);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM relation_definitions");
    expect(rows[0].n).toBe(0);
  });

  it("creating a relation property with an inverse against a non-existent targetDatabaseId is rejected", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const bogusTargetId = randomUUID();

    await expect(
      chokePoint.createRelationProperty({
        sourceDatabaseId: db.id,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: bogusTargetId,
        inverse: { key: "project", name: "Project" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const properties = await chokePoint.listProperties(db.id);
    expect(properties).toHaveLength(0);
  });

  it("createRelationProperty({ locked: true }) succeeds and returns a locked property whose config carries the relation definition and target database", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
      locked: true,
    });

    expect(property.locked).toBe(true);
    expect(property.config).toMatchObject({ targetDatabaseId: target.id });
    expect(property.config.relationDefinitionId).toBeTruthy();
  });

  it("createRelationProperty({ locked: true, inverse: { locked: true } }) locks both sides of the pair independently", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    const { property, inverseProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
      locked: true,
      inverse: { key: "project", name: "Project", locked: true },
    });

    expect(property.locked).toBe(true);
    expect(inverseProperty?.locked).toBe(true);
    expect(inverseProperty?.config).toMatchObject({ targetDatabaseId: db.id });
    expect(inverseProperty?.config.relationDefinitionId).toBeTruthy();

    // The stored row must agree with the returned value — not just the in-memory patch.
    const reloadedInverse = await chokePoint.getProperty(inverseProperty!.id);
    expect(reloadedInverse?.locked).toBe(true);
  });
});
