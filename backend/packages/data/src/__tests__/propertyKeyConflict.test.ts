import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("issue #672: duplicate property key maps to a 409 ConflictError", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects creating a property with a key already used in the same database", async () => {
    const database = await chokePoint.createDatabase({ name: "D" });
    await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });

    const attempt = chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Other Title",
      type: "text",
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      details: { field: "key", reason: "duplicate" },
    });

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM properties WHERE database_id = $1 AND key = 'title'`,
      [database.id],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("allows the same key in a different database", async () => {
    const first = await chokePoint.createDatabase({ name: "D1" });
    const second = await chokePoint.createDatabase({ name: "D2" });
    await chokePoint.createProperty({ databaseId: first.id, key: "title", name: "Title", type: "text" });

    const property = await chokePoint.createProperty({
      databaseId: second.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    expect(property.key).toBe("title");
  });
});
