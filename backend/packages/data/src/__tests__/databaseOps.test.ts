import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError, NotFoundError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point databaseOps", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("a system database cannot be archived", async () => {
    const db = await chokePoint.createDatabase({ name: "System DB", system: true });
    await expect(chokePoint.archiveDatabase(db.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("renameDatabase changes the name, including for a system database", async () => {
    const db = await chokePoint.createDatabase({ name: "Before" });
    const renamed = await chokePoint.renameDatabase(db.id, "After");
    expect(renamed.name).toBe("After");
    expect((await chokePoint.getDatabase(db.id))?.name).toBe("After");

    const system = await chokePoint.createDatabase({ name: "System Before", system: true });
    const renamedSystem = await chokePoint.renameDatabase(system.id, "System After");
    expect(renamedSystem.name).toBe("System After");
  });

  it("renameDatabase on a missing database raises NotFoundError", async () => {
    await expect(chokePoint.renameDatabase(randomUUID(), "New Name")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listDatabases excludes archived databases but includes everything else", async () => {
    const kept = await chokePoint.createDatabase({ name: "Kept" });
    const archived = await chokePoint.createDatabase({ name: "Archived" });
    await chokePoint.archiveDatabase(archived.id);

    const listed = await chokePoint.listDatabases();
    const ids = listed.map((db) => db.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(archived.id);
  });
});
