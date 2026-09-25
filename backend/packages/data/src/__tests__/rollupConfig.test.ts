import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { applyRollupConfig } from "../rollup/config.js";
import { ValidationError } from "../errors.js";
import * as relationsStore from "../chokePoint/relationsStore.js";

let pool: Pool;
let chokePoint: ChokePoint;

interface DependencyDbRow {
  relation_definition_id: string;
  source_database_id: string;
  source_property_key: string | null;
}

async function readDependencies(client: PoolClient, rollupPropertyId: string): Promise<DependencyDbRow[]> {
  const { rows } = await client.query<DependencyDbRow>(
    `SELECT relation_definition_id, source_database_id, source_property_key
     FROM rollup_dependencies WHERE rollup_property_id = $1`,
    [rollupPropertyId],
  );
  return rows;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

describe("applyRollupConfig", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeRollup() {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    const { property: relationProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });
    const rollup = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "totalHours",
      name: "Total hours",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    const relationDefinition = await withClient((client) =>
      relationsStore.getRelationDefinitionByPropertyId(client, relationProperty.id),
    );
    if (!relationDefinition) throw new Error("expected createRelationProperty to create a relation definition");
    return { tasks, relationProperty, relationDefinition, rollup };
  }

  it("upserts the dependency row from a valid config", async () => {
    const { tasks, relationDefinition, rollup } = await makeRollup();

    await withClient(async (client) => {
      await client.query(`DELETE FROM rollup_dependencies WHERE rollup_property_id = $1`, [rollup.id]);
      await applyRollupConfig(client, rollup);

      expect(await readDependencies(client, rollup.id)).toEqual([
        {
          relation_definition_id: relationDefinition.id,
          source_database_id: tasks.id,
          source_property_key: "hours",
        },
      ]);
    });
  });

  it("rejects a relation property that has no relation definition", async () => {
    const { relationDefinition, rollup } = await makeRollup();

    await withClient(async (client) => {
      await client.query(`DELETE FROM relation_definitions WHERE id = $1`, [relationDefinition.id]);

      const error = await applyRollupConfig(client, rollup).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        message: "Relation property 'tasks' has no relation definition",
        details: { field: "relationPropertyKey" },
      });
      expect(await readDependencies(client, rollup.id)).toEqual([]);
    });
  });

  it("rejects a relation property whose config has no targetDatabaseId", async () => {
    const { relationProperty, rollup } = await makeRollup();

    await withClient(async (client) => {
      await client.query(`DELETE FROM rollup_dependencies WHERE rollup_property_id = $1`, [rollup.id]);
      await client.query(`UPDATE properties SET config = config - 'targetDatabaseId' WHERE id = $1`, [
        relationProperty.id,
      ]);
      const countRollup = { ...rollup, config: { relationPropertyKey: "tasks", aggregation: "count" } };

      const error = await applyRollupConfig(client, countRollup).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        message: "Relation property has no targetDatabaseId in config",
        details: { field: "relationPropertyKey" },
      });
      expect(await readDependencies(client, rollup.id)).toEqual([]);
    });
  });
});
