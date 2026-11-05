import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID, PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

export async function runTasksSchemaCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    if (!tasks || !events || !people || !files) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    for (const [key, type, owner, config] of [
      ["flagged", "checkbox", "user", {}],
      ["description", "longText", "user", {}],
      ["since", "date", "system", {}],
      ["sinceTime", "json", "system", {}],
      ["completedOn", "date", "user", {}],
      ["completedAt", "date", "system", { includeTime: true }],
      ["hiddenUntil", "date", "system", { includeTime: true }],
      ["effectiveDate", "date", "system", {}],
      ["seriesId", "text", "system", {}],
      ["occurrenceDate", "date", "system", {}],
      ["recurrence", "json", "system", {}],
    ] as const) {
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         SELECT $1, $2, NULL, $3, $4::jsonb, false, $5, $6
         WHERE NOT EXISTS (SELECT 1 FROM properties WHERE database_id = $1 AND key = $2)`,
        [tasks.id, key, type, JSON.stringify(config), owner, owner === "system" ? TASKS_MODULE_ID : null],
      );
    }
    const timeUpdate = await client.query(
      `UPDATE properties SET owner_process = $2 WHERE database_id = $1 AND key = 'time'
       AND owner = 'system' AND owner_process IS DISTINCT FROM $2`,
      [tasks.id, TASKS_MODULE_ID],
    );
    if (timeUpdate.rowCount === null || timeUpdate.rowCount > 1) throw new Error("Unexpected Tasks time update count");
    const statusRows = await client.query<{ id: string; config: unknown }>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'status'",
      [tasks.id],
    );
    const status = statusRows.rows[0];
    if (status) {
      const config = z
        .object({ options: z.array(z.object({ key: z.string() }).passthrough()).optional() })
        .passthrough()
        .parse(status.config);
      const options = config.options ?? [];
      if (!options.some((option) => option.key === "missed")) {
        const result = await client.query(
          "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
          [status.id, JSON.stringify([...options, { key: "missed" }])],
        );
        requireAffectedRows(result, "tasks status options");
      }
    }
    for (const [databaseA, keyA, databaseB, keyB, cardinality, owner] of [
      [tasks.id, "people", people.id, "tasks", "many_to_many", "user"],
      [tasks.id, "files", files.id, "tasks", "many_to_many", "user"],
      [tasks.id, "hostEvents", events.id, "hostedTasks", "many_to_many", "system"],
      [events.id, "completedTasks", tasks.id, "completedInEvent", "one_to_many", "system"],
    ] as const) {
      const existing = await client.query<{
        id: string;
        database_id: string;
        key: string;
        type: string;
        owner: string;
        owner_process: string | null;
      }>(
        "SELECT id, database_id, key, type, owner, owner_process FROM properties WHERE (database_id = $1 AND key = $2) OR (database_id = $3 AND key = $4)",
        [databaseA, keyA, databaseB, keyB],
      );
      if (existing.rows.length === 2) continue;
      const ids: string[] = [];
      for (const [databaseId, key] of [
        [databaseA, keyA],
        [databaseB, keyB],
      ] as const) {
        const prior = existing.rows.find((row) => row.database_id === databaseId && row.key === key);
        if (prior) {
          if (
            prior.type !== "relation" ||
            prior.owner !== owner ||
            prior.owner_process !== (owner === "system" ? TASKS_MODULE_ID : null)
          ) {
            throw new Error(`Existing Tasks relation ${key} has an incompatible owner or type`);
          }
          const linked = await client.query<{ id: string }>(
            "SELECT id FROM relation_definitions WHERE property_id_a = $1 OR property_id_b = $1",
            [prior.id],
          );
          if (linked.rows.length) throw new Error(`Existing Tasks relation ${key} is already linked`);
          ids.push(prior.id);
          continue;
        }
        const result = await client.query<{ id: string }>(
          `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
           VALUES ($1, $2, NULL, 'relation', '{}'::jsonb, false, $3, $4) RETURNING id`,
          [databaseId, key, owner, owner === "system" ? TASKS_MODULE_ID : null],
        );
        ids.push(requireSingleRow(result.rows, "relation property").id);
      }
      const [idA, idB] = ids;
      if (!idA || !idB) throw new Error("Missing Tasks relation properties");
      const relation = await client.query<{ id: string }>(
        "INSERT INTO relation_definitions (property_id_a, property_id_b, cardinality) VALUES ($1, $2, $3) RETURNING id",
        [idA, idB, cardinality],
      );
      const relationId = requireSingleRow(relation.rows, "relation definition").id;
      for (const [id, target] of [
        [idA, databaseB],
        [idB, databaseA],
      ] as const) {
        const result = await client.query(
          "UPDATE properties SET config = jsonb_build_object('relationDefinitionId', $2::uuid, 'targetDatabaseId', $3::uuid) WHERE id = $1",
          [id, relationId, target],
        );
        requireAffectedRows(result, "Tasks relation config");
      }
    }
  });
}
