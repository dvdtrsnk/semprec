import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

/**
 * Re-runs the actual 0029 backfill SQL (already applied once, against empty tables, by
 * globalSetup) against whatever `properties` rows the test has set up — the only way to
 * exercise its upgrade/idempotency/abort logic against pre-existing data without
 * duplicating its SQL by hand. Mirrors relationConfigRepairMigration.test.ts's
 * `runConfigRepairMigration` helper.
 */
async function runSelectOptionKeysMigration(): Promise<void> {
  const sql = await readFile(path.join(MIGRATIONS_DIR, "0029_select_option_keys.sql"), "utf8");
  await pool.query(sql);
}

describe("select/multi_select option keys (issue #145)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("migration upgrade/idempotency/abort behavior", () => {
    it("upgrades a pre-existing bare-string options array to { key } objects, preserving order", async () => {
      // owner_module_id 'tasks' + property key 'status' matches the migration's shipped
      // catalog for these exact values (mirroring seedTenDatabases.ts's Tasks.status), so
      // they get no label — see the "labels a bare string outside the shipped catalog" test
      // below for the opposite case.
      const db = await chokePoint.createDatabase({ name: "OptionKeysUpgrade", system: true, ownerModuleId: "tasks" });
      // Simulate a row written before this issue existed — the store's own createProperty now
      // rejects a bare-string array, so this bypasses it via a raw insert, same as the other
      // migration tests' "corrupt/pre-existing data" setup.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'status', 'Status', 'select', '{"options": ["notDone", "done", "wontDo"]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await runSelectOptionKeysMigration();

      const property = await chokePoint.getProperty(propertyId);
      expect(property?.config).toEqual({ options: [{ key: "notDone" }, { key: "done" }, { key: "wontDo" }] });
    });

    it("labels a bare string that is not part of the shipped catalog for that property (user-added/renamed)", async () => {
      // Same owner_module_id/property key as the shipped-catalog test above, but with an
      // extra value the shipped Tasks.status catalog (notDone/done/wontDo) never listed —
      // a stand-in for an option a user added or renamed before this issue's validators
      // existed. Per the issue's Task, it must come out labeled with its original text,
      // while the recognized shipped value next to it still gets no label.
      const db = await chokePoint.createDatabase({
        name: "OptionKeysUserAdded",
        system: true,
        ownerModuleId: "tasks",
      });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'status', 'Status', 'select', '{"options": ["notDone", "urgentTriage"]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await runSelectOptionKeysMigration();

      const property = await chokePoint.getProperty(propertyId);
      expect(property?.config).toEqual({
        options: [{ key: "notDone" }, { key: "urgentTriage", label: "urgentTriage" }],
      });
    });

    it("labels every bare string when the migration doesn't recognize the property at all", async () => {
      // A select property the shipped catalog has no entry for (an arbitrary, non-system
      // database here stands in for that) — every bare string must come out labeled, since
      // none of them can be confirmed as a shipped value.
      const db = await chokePoint.createDatabase({ name: "OptionKeysUnrecognized" });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'priority', 'Priority', 'select', '{"options": ["low", "high"]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await runSelectOptionKeysMigration();

      const property = await chokePoint.getProperty(propertyId);
      expect(property?.config).toEqual({
        options: [
          { key: "low", label: "low" },
          { key: "high", label: "high" },
        ],
      });
    });

    it("is a no-op on already-migrated { key, label? } options (idempotent, safe to run twice)", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionKeysNoop" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "notDone" }, { key: "done", label: "Finished" }] },
      });

      await runSelectOptionKeysMigration();
      await runSelectOptionKeysMigration();

      const after = await chokePoint.getProperty(property.id);
      expect(after?.config).toEqual({ options: [{ key: "notDone" }, { key: "done", label: "Finished" }] });
    });

    it("leaves a user-renamed option's explicit label override untouched on upgrade", async () => {
      const db = await chokePoint.createDatabase({
        name: "OptionKeysLabelPreserved",
        system: true,
        ownerModuleId: "tasks",
      });
      // A pre-existing row already carrying a manual { key, label } override alongside plain
      // shipped-catalog strings — the migration must only wrap the strings, not touch the object.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'status', 'Status', 'select', '{"options": ["notDone", {"key": "done", "label": "Finished"}]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await runSelectOptionKeysMigration();

      const property = await chokePoint.getProperty(propertyId);
      expect(property?.config).toEqual({ options: [{ key: "notDone" }, { key: "done", label: "Finished" }] });
    });

    it("upgrades multi_select options the same way as select", async () => {
      const db = await chokePoint.createDatabase({
        name: "OptionKeysMultiSelect",
        system: true,
        ownerModuleId: "healthRecords",
      });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'tags', 'Tags', 'multi_select', '{"options": ["bloodTests", "medication"]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await runSelectOptionKeysMigration();

      const property = await chokePoint.getProperty(propertyId);
      expect(property?.config).toEqual({ options: [{ key: "bloodTests" }, { key: "medication" }] });
    });

    it("does not touch a non-select property's config", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionKeysNonSelect" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "sections",
        name: "Sections",
        type: "longText",
        config: { options: ["purpose", "allowed"] },
      });

      await runSelectOptionKeysMigration();

      const after = await chokePoint.getProperty(property.id);
      expect(after?.config).toEqual({ options: ["purpose", "allowed"] });
    });

    it("aborts with the offending property id when an option is neither a string nor a { key } object", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionKeysMalformedScalar" });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'status', 'Status', 'select', '{"options": ["done", 42]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await expect(runSelectOptionKeysMigration()).rejects.toThrow(new RegExp(propertyId));
    });

    it("aborts with the offending property id when an option object is missing a string key", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionKeysMalformedObject" });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO properties (database_id, key, name, type, config, owner)
       VALUES ($1, 'status', 'Status', 'select', '{"options": [{"label": "No key"}]}'::jsonb, 'user')
       RETURNING id`,
        [db.id],
      );
      const propertyId = rows[0]!.id;

      await expect(runSelectOptionKeysMigration()).rejects.toThrow(new RegExp(propertyId));
    });

    it("is a no-op when no select/multi_select properties exist yet", async () => {
      await expect(runSelectOptionKeysMigration()).resolves.toBeUndefined();
    });
  });

  describe("option validation on write", () => {
    it("accepts a { key } option with no label", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationBasic" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "notDone" }, { key: "done" }] },
      });
      expect(property.config).toEqual({ options: [{ key: "notDone" }, { key: "done" }] });
    });

    it("accepts a { key, label } option", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationLabel" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "custom", label: "Custom label" }] },
      });
      expect(property.config).toEqual({ options: [{ key: "custom", label: "Custom label" }] });
    });

    it("rejects a bare-string option on create", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectString" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: ["notDone"] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an option object missing a string key", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectMissingKey" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ label: "No key" }] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an option with an empty-string key", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectEmptyKey" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ key: "" }] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a null option element", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectNullElement" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [null] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a non-string label", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectBadLabel" });
      await expect(
        chokePoint.createProperty({
          databaseId: db.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ key: "custom", label: 42 }] },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an invalid option on updatePropertyConfig too", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationRejectOnUpdate" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "status",
        name: "Status",
        type: "select",
        config: { options: [{ key: "notDone" }] },
      });
      await expect(chokePoint.updatePropertyConfig(property.id, { options: ["done"] })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("does not validate options shape for a non-select property type", async () => {
      const db = await chokePoint.createDatabase({ name: "OptionValidationSkipNonSelect" });
      const property = await chokePoint.createProperty({
        databaseId: db.id,
        key: "sections",
        name: "Sections",
        type: "longText",
        config: { options: ["purpose", "allowed"] },
      });
      expect(property.config).toEqual({ options: ["purpose", "allowed"] });
    });
  });
});
