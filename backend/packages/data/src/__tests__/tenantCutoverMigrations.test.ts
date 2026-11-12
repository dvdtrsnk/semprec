import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { ForbiddenError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { runRatingFilterPresetsCutoverMigration } from "../seed/ratingFilterPresetsCutoverMigration.js";
import { runSelectOptionColorsCutoverMigration } from "../seed/selectOptionColorsCutoverMigration.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID } from "../transcription/transcriptionActions.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

interface TenantState {
  statusOptions: string[];
  pipelineOwners: Array<string | null>;
  speakers: { targetDatabaseId: string } | null;
  peopleId: string;
  transcriptsId: string;
  heartbeats: Array<{ projectItemId: string; transcriptsDatabaseId: string }>;
}

async function readState(tenantId: string): Promise<TenantState> {
  return runInTenant(tenantId, async () => {
    const db = async (moduleId: string): Promise<string> => {
      const { rows } = await dataPool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        moduleId,
      ]);
      if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
      return rows[0].id;
    };
    const transcriptsId = await db("transcripts");
    const peopleId = await db("people");
    const { rows: props } = await dataPool.query<{
      key: string;
      owner_process: string | null;
      config: { options?: Array<{ key: string }>; targetDatabaseId?: string };
    }>("SELECT key, owner_process, config FROM properties WHERE database_id = $1", [transcriptsId]);
    const status = props.find((p) => p.key === "status");
    const speakers = props.find((p) => p.key === "speakers");
    const { rows: heartbeats } = await dataPool.query<{
      project_item_id: string;
      action_config: { transcriptsDatabaseId: string };
    }>("SELECT project_item_id, action_config FROM project_heartbeats WHERE action_id = $1", [
      TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
    ]);
    return {
      statusOptions: (status?.config.options ?? []).map((o) => o.key),
      pipelineOwners: ["status", "date", "link"].map((k) => props.find((p) => p.key === k)?.owner_process ?? null),
      speakers: speakers?.config.targetDatabaseId ? { targetDatabaseId: speakers.config.targetDatabaseId } : null,
      peopleId,
      transcriptsId,
      heartbeats: heartbeats.map((h) => ({
        projectItemId: h.project_item_id,
        transcriptsDatabaseId: h.action_config.transcriptsDatabaseId,
      })),
    };
  });
}

/** Seeds the tenant, then reverts its Transcripts catalog and requeue heartbeat to the pre-cutover shape. */
async function seedOldShape(tenantId: string, options: { keepHeartbeat?: boolean } = {}): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const { transcriptsId } = await readState(tenantId);
  await adminPool.query(
    `UPDATE properties SET config = jsonb_set(config, '{options}', '[{"key":"recording"},{"key":"processing"},{"key":"done"}]'::jsonb)
     WHERE database_id = $1 AND key = 'status'`,
    [transcriptsId],
  );
  await adminPool.query(
    `UPDATE properties SET owner_process = NULL WHERE database_id = $1 AND key = ANY('{status,date,link}')`,
    [transcriptsId],
  );
  const { rows } = await adminPool.query<{ id: string; config: { relationDefinitionId: string } }>(
    "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'speakers'",
    [transcriptsId],
  );
  if (rows[0]) {
    await adminPool.query("DELETE FROM properties WHERE id = $1", [rows[0].id]);
    await adminPool.query("DELETE FROM relation_definitions WHERE id = $1", [rows[0].config.relationDefinitionId]);
  }
  if (!options.keepHeartbeat) {
    await adminPool.query(
      `DELETE FROM project_heartbeats WHERE action_id = $1
       AND project_item_id IN (SELECT id FROM items WHERE tenant_id = $2)`,
      [TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID, tenantId],
    );
  }
}

async function snapshot(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const table of ["properties", "relation_definitions", "project_heartbeats"]) {
    const { rows } = await adminPool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`);
    out.push(rows);
  }
  return out;
}

function runCutovers(pool: Pool): Promise<void> {
  return runAsSystem("test cutover", () => runTenantCutoverMigrations(pool));
}

async function expectUpgraded(tenantId: string): Promise<void> {
  const state = await readState(tenantId);
  expect(state.statusOptions).toContain("error");
  expect(state.pipelineOwners).toEqual([
    TRANSCRIPTION_OWNER_PROCESS,
    TRANSCRIPTION_OWNER_PROCESS,
    TRANSCRIPTION_OWNER_PROCESS,
  ]);
  expect(state.speakers).toEqual({ targetDatabaseId: state.peopleId });
  expect(state.heartbeats).toHaveLength(1);
  expect(state.heartbeats[0]?.transcriptsDatabaseId).toBe(state.transcriptsId);
  const { rows } = await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM items WHERE id = $1", [
    state.heartbeats[0]?.projectItemId,
  ]);
  expect(rows[0]?.tenant_id).toBe(tenantId);
}

describe("runTenantCutoverMigrations (issue #1007)", () => {
  let zero: string;
  let b: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    const role = await runAsSystem("check tenant cutover role", () =>
      dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    b = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("adds Inbox Markdown format for each old tenant once and preserves existing values", async () => {
    for (const tenant of [zero, b]) await runInTenant(tenant, () => seedSystem(dataPool, createViewTypeRegistry()));
    const read = (tenant: string) =>
      runInTenant(tenant, async () => {
        const result = await dataPool.query<{ id: string; config: Record<string, unknown>; version: string }>(
          `SELECT p.id, p.config, p.xmin::text AS version FROM properties p
         JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
         WHERE d.owner_module_id = 'inbox' AND p.key = 'text'`,
        );
        if (!result.rows[0]) throw new Error("Inbox text property missing");
        return result.rows[0];
      });
    expect((await read(zero)).config.format).toBe("markdown");
    const old = await read(b);
    // The schema-locked historical catalog cannot be reverted through the public property API.
    const result = await adminPool.query(
      "UPDATE properties SET config = config - 'format' WHERE tenant_id = $1 AND id = $2",
      [b, old.id],
    );
    expect(result.rowCount).toBe(1);
    await runCutovers(dataPool);
    const upgraded = await read(b);
    expect(upgraded.config).toEqual({ ...old.config, format: "markdown" });
    await runCutovers(dataPool);
    expect(await read(b)).toEqual(upgraded);
    expect((await read(zero)).config.format).toBe("markdown");
  });

  it("colors each listed catalog for an existing tenant and preserves unlisted options", async () => {
    for (const tenant of [zero, b]) await runInTenant(tenant, () => seedSystem(dataPool, createViewTypeRegistry()));
    const catalogs = [
      ["files", "type", { pdf: "#FF3B30", xlsx: "#34C759", docx: "#007AFF", jpg: "#FF9500" }],
      ["healthRecords", "status", { monitoring: "#FF9500", resolved: "#34C759" }],
      [
        "healthRecords",
        "tags",
        { bloodTests: "#FF9500", medication: "#AF52DE", bloodPressure: "#FF2D55", prevention: "#34C759" },
      ],
      [
        "people",
        "relationship",
        {
          client: "#007AFF",
          closeFriend: "#AF52DE",
          parent: "#FF9500",
          girlfriend: "#FF2D55",
          therapist: "#34C759",
          neighbor: "#8E8E93",
          colleague: "#8E8E93",
          craftsman: "#8E8E93",
          doctor: "#8E8E93",
        },
      ],
      ["events", "type", { meeting: "#AF52DE", standup: "#007AFF", event: "#FF3B30" }],
      ["projects", "status", { inProgress: "#007AFF", longTerm: "#AF52DE", done: "#34C759", archived: "#8E8E93" }],
      ["books", "status", { toRead: "#8E8E93", reading: "#007AFF", read: "#34C759" }],
      ["movies", "status", { planned: "#8E8E93", watching: "#007AFF", watched: "#34C759" }],
    ] as const;
    const read = (tenant: string, moduleId: string, key: string) =>
      runInTenant(tenant, async () => {
        const { rows } = await dataPool.query<Record<string, unknown>>(
          `SELECT p.id, p.xmin::text AS version, p.config FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = $1 AND p.key = $2`,
          [moduleId, key],
        );
        return z
          .object({
            id: z.string(),
            version: z.string(),
            config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()) }).passthrough(),
          })
          .parse(rows[0]);
      });
    for (const [moduleId, key] of catalogs) {
      const old = await read(b, moduleId, key);
      const options = old.config.options.map(({ color: _color, ...option }) => option);
      options.push({ key: "custom", marker: "preserved" });
      // These schema-locked catalogs cannot be reverted via the public property API.
      const updated = await adminPool.query(
        "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
        [b, old.id, JSON.stringify(options)],
      );
      expect(updated.rowCount).toBe(1);
    }
    await runCutovers(dataPool);
    const versions = new Map<string, string>();
    for (const [moduleId, key, expectedColors] of catalogs) {
      const fresh = await read(zero, moduleId, key);
      const migrated = await read(b, moduleId, key);
      expect(migrated.config.options).toEqual([...fresh.config.options, { key: "custom", marker: "preserved" }]);
      for (const [optionKey, color] of Object.entries(expectedColors)) {
        expect(migrated.config.options.find((option) => option.key === optionKey)).toMatchObject({ color });
      }
      versions.set(`${moduleId}.${key}`, migrated.version);
    }
    await runCutovers(dataPool);
    for (const [moduleId, key] of catalogs)
      expect((await read(b, moduleId, key)).version).toBe(versions.get(`${moduleId}.${key}`));
  });

  it("skips missing databases and missing listed options without writes", async () => {
    const empty = await createTestTenant(adminPool);
    const emptyBefore = await runInTenant(empty, () => dataPool.query("SELECT id FROM properties"));
    await runInTenant(empty, () => runSelectOptionColorsCutoverMigration(dataPool));
    await runCutovers(dataPool);
    await runCutovers(dataPool);
    expect((await runInTenant(empty, () => dataPool.query("SELECT id FROM properties"))).rows).toEqual(
      emptyBefore.rows,
    );
    await runInTenant(b, () => seedSystem(dataPool, createViewTypeRegistry()));
    const rows = await runInTenant(b, () =>
      dataPool.query<{ id: string; config: unknown }>(
        "SELECT p.id, p.config FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'projects' AND p.key = 'status'",
      ),
    );
    const prop = z
      .object({
        id: z.string(),
        config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()) }).passthrough(),
      })
      .parse(rows.rows[0]);
    const options = prop.config.options.filter((option) => option.key !== "longTerm");
    const changed = await adminPool.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
      [b, prop.id, JSON.stringify(options)],
    );
    expect(changed.rowCount).toBe(1);
    const read = () =>
      runInTenant(b, () =>
        dataPool.query<{ config: unknown; version: string }>(
          "SELECT config, xmin::text AS version FROM properties WHERE id = $1",
          [prop.id],
        ),
      );
    const before = await read();
    await runInTenant(b, () => runSelectOptionColorsCutoverMigration(dataPool));
    await runCutovers(dataPool);
    await runCutovers(dataPool);
    expect((await read()).rows).toEqual(before.rows);
  });

  it("colors old select catalogs without overwriting existing colors and does not rewrite on replay", async () => {
    for (const tenant of [zero, b]) await runInTenant(tenant, () => seedSystem(dataPool, createViewTypeRegistry()));
    const read = (tenant: string) =>
      runInTenant(tenant, async () => {
        const { rows } = await dataPool.query<Record<string, unknown>>(
          `SELECT p.id, p.xmin::text AS version, p.config FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'projects' AND p.key = 'status'`,
        );
        return z
          .object({
            id: z.string(),
            version: z.string(),
            config: z
              .object({ options: z.array(z.object({ key: z.string(), color: z.string().optional() }).passthrough()) })
              .passthrough(),
          })
          .parse(rows[0]);
      });
    const old = await read(b);
    const options = [
      { key: "inProgress", color: "#123456", extra: true },
      { key: "longTerm" },
      { key: "done" },
      { key: "archived" },
      { key: "custom" },
    ];
    // Locked catalogs cannot be reverted by the production property API.
    const updated = await adminPool.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
      [b, old.id, JSON.stringify(options)],
    );
    expect(updated.rowCount).toBe(1);
    await runCutovers(dataPool);
    const migrated = await read(b);
    expect(migrated.config.options).toEqual([
      { key: "inProgress", color: "#123456", extra: true },
      { key: "longTerm", color: "#AF52DE" },
      { key: "done", color: "#34C759" },
      { key: "archived", color: "#8E8E93" },
      { key: "custom" },
    ]);
    expect((await read(zero)).config.options).toEqual([
      { key: "inProgress", color: "#007AFF" },
      { key: "longTerm", color: "#AF52DE" },
      { key: "done", color: "#34C759" },
      { key: "archived", color: "#8E8E93" },
    ]);
    await runCutovers(dataPool);
    expect(await read(b)).toEqual(migrated);
  });

  it("colors four Health records tags of an older tenant, keeps colors that are already set and does not rewrite on replay (issue #1705)", async () => {
    for (const tenant of [zero, b]) await runInTenant(tenant, () => seedSystem(dataPool, createViewTypeRegistry()));
    const read = (tenant: string) =>
      runInTenant(tenant, async () => {
        const { rows } = await dataPool.query<Record<string, unknown>>(
          `SELECT p.id, p.xmin::text AS version, p.config FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.owner_module_id = 'healthRecords' AND p.key = 'tags'`,
        );
        return z
          .object({
            id: z.string(),
            version: z.string(),
            config: z.object({ options: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
          })
          .parse(rows[0]);
      });
    const seeded = [
      { key: "bloodTests", color: "#FF9500" },
      { key: "medication", color: "#AF52DE" },
      { key: "epilepsy" },
      { key: "dentalHygiene" },
      { key: "bloodPressure", color: "#FF2D55" },
      { key: "prevention", color: "#34C759" },
    ];
    expect((await read(zero)).config.options).toStrictEqual(seeded);
    const old = await read(b);
    // The four tags of a tenant seeded before issues #1700 and #1705, two of them with a color of their own.
    const options = [
      { key: "bloodTests" },
      { key: "medication", color: "#123456", extra: true },
      { key: "epilepsy", color: "#654321" },
      { key: "dentalHygiene" },
    ];
    // The schema-locked Health records catalog cannot be reverted through the production property API.
    const updated = await adminPool.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
      [b, old.id, JSON.stringify(options)],
    );
    expect(updated.rowCount).toBe(1);
    const untouched = await read(zero);

    await runCutovers(dataPool);

    const migrated = await read(b);
    // `bloodPressure` and `prevention` are appended by the tags cutover of #1700 and colored in the same run.
    expect(migrated.config.options).toStrictEqual([
      { key: "bloodTests", color: "#FF9500" },
      { key: "medication", color: "#123456", extra: true },
      { key: "epilepsy", color: "#654321" },
      { key: "dentalHygiene" },
      { key: "bloodPressure", color: "#FF2D55" },
      { key: "prevention", color: "#34C759" },
    ]);
    expect(await read(zero)).toEqual(untouched);

    await runCutovers(dataPool);

    expect(await read(b)).toEqual(migrated);
    expect(await read(zero)).toEqual(untouched);
  });

  it("upgrades every tenant in its own scope", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    expect((await readState(b)).statusOptions).not.toContain("error");

    await runCutovers(dataPool);

    await expectUpgraded(zero);
    await expectUpgraded(b);
    expect((await readState(zero)).transcriptsId).not.toBe((await readState(b)).transcriptsId);
  });

  it("upgrades populated transcript relations through the tenant runner without changing existing edges", async () => {
    for (const tenantId of [zero, b]) {
      await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
      const chokePoint = createChokePoint(dataPool);
      await runInTenant(tenantId, async () => {
        const { rows } = await dataPool.query<{ id: string; owner_module_id: string }>(
          "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
          [["transcripts", "events", "people"]],
        );
        const transcripts = rows.find((row) => row.owner_module_id === "transcripts");
        const events = rows.find((row) => row.owner_module_id === "events");
        const people = rows.find((row) => row.owner_module_id === "people");
        if (!transcripts || !events || !people) throw new Error("Missing transcript, event or people database");
        const transcript = await chokePoint.createItem({ databaseId: transcripts.id, properties: {} });
        const event = await chokePoint.createItem({ databaseId: events.id, properties: { date: "2026-10-16" } });
        const person = await chokePoint.createItem({ databaseId: people.id, properties: {} });
        await withTransaction(dataPool, (client) =>
          itemsStore.writeComputed(client, transcripts.id, transcript.id, "segments", [{ speaker: "SPEAKER_00" }]),
        );
        const eventProperty = (await chokePoint.listProperties(events.id)).find(
          (property) => property.key === "transcript",
        );
        if (!eventProperty) throw new Error("Missing event transcript property");
        await chokePoint.createRelation({
          relationPropertyId: eventProperty.id,
          callerItemId: event.id,
          targetItemId: transcript.id,
        });
        const speakerProperty = (await chokePoint.listProperties(transcripts.id)).find(
          (property) => property.key === "speakers",
        );
        if (!speakerProperty) throw new Error("Missing speakers property");
        await chokePoint.createRelation({
          relationPropertyId: speakerProperty.id,
          callerItemId: transcript.id,
          targetItemId: person.id,
          metadata: { speaker: "SPEAKER_00" },
        });
        // Recreate the pre-1470 catalog; normal APIs cannot remove locked system properties.
        const definitions = await dataPool.query<{ id: string }>(
          "SELECT config->>'relationDefinitionId' AS id FROM properties WHERE database_id = $1 AND key = ANY($2::text[])",
          [transcripts.id, ["project", "company", "people"]],
        );
        expect(definitions.rows).toHaveLength(3);
        const ids = definitions.rows.map((row) => row.id);
        await dataPool.query("DELETE FROM properties WHERE config->>'relationDefinitionId' = ANY($1::text[])", [ids]);
        await dataPool.query("DELETE FROM relation_definitions WHERE id = ANY($1::uuid[])", [ids]);
      });
    }
    type EdgeRow = { id: string; relation_definition_id: string; item_a: string; item_b: string; metadata: string };
    const EDGES_SQL =
      "SELECT id, relation_definition_id, item_a, item_b, metadata::text AS metadata FROM item_relations ORDER BY id";
    const before = await adminPool.query<EdgeRow>(EDGES_SQL);
    // Per tenant: the Event's transcript, the transcript's speaker and the Event's calendar, which the
    // Event's create hook linked (issue #1761).
    expect(before.rows).toHaveLength(6);
    const speakerCatalogBefore = await adminPool.query<Record<string, unknown>>(
      `SELECT to_jsonb(p)::text AS property, to_jsonb(r)::text AS definition FROM properties p
       JOIN relation_definitions r ON r.id = (p.config->>'relationDefinitionId')::uuid
       WHERE p.key = 'speakers' ORDER BY p.id`,
    );
    const catalogSchema = z.array(z.object({ property: z.string(), definition: z.string() }));
    const speakerBefore = catalogSchema.parse(speakerCatalogBefore.rows);
    expect(speakerBefore).toHaveLength(2);
    await runCutovers(dataPool);
    const firstEdges = await adminPool.query<EdgeRow>(EDGES_SQL);
    // Every existing edge is kept, with its id, definition, endpoints and metadata, and none is added: each
    // Event has its calendar already, so the Calendars cutover (issue #1600) links nothing.
    expect(firstEdges.rows).toEqual(before.rows);
    const speakerCatalogAfter = await adminPool.query<Record<string, unknown>>(
      `SELECT to_jsonb(p)::text AS property, to_jsonb(r)::text AS definition FROM properties p
       JOIN relation_definitions r ON r.id = (p.config->>'relationDefinitionId')::uuid
       WHERE p.key = 'speakers' ORDER BY p.id`,
    );
    expect(catalogSchema.parse(speakerCatalogAfter.rows)).toEqual(speakerBefore);
    await runCutovers(dataPool);
    const after = await adminPool.query<EdgeRow>(EDGES_SQL);
    expect(after.rows).toEqual(firstEdges.rows);
    const speakerCatalogAfterSecondRun = await adminPool.query<Record<string, unknown>>(
      `SELECT to_jsonb(p)::text AS property, to_jsonb(r)::text AS definition FROM properties p
       JOIN relation_definitions r ON r.id = (p.config->>'relationDefinitionId')::uuid
       WHERE p.key = 'speakers' ORDER BY p.id`,
    );
    expect(catalogSchema.parse(speakerCatalogAfterSecondRun.rows)).toEqual(speakerBefore);
    for (const tenantId of [zero, b]) {
      const state = await readState(tenantId);
      const properties = await runInTenant(tenantId, () =>
        dataPool.query<{ key: string }>("SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
          state.transcriptsId,
          ["project", "company", "people"],
        ]),
      );
      expect(properties.rows.map((row) => row.key).sort()).toEqual(["company", "people", "project"]);
    }
  });

  it("repairs legacy mail database keys through the tenant cutover runner", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    for (const tenantId of [zero, b]) {
      await runInTenant(tenantId, () =>
        dataPool.query("UPDATE databases SET key = NULL WHERE system AND owner_module_id = ANY($1::text[])", [
          ["emails", "folders", "mailboxes"],
        ]),
      );
    }
    await runCutovers(dataPool);
    for (const tenantId of [zero, b]) {
      const rows = await runInTenant(
        tenantId,
        async () =>
          (
            await dataPool.query<{ key: string }>(
              "SELECT key FROM databases WHERE system AND owner_module_id = ANY($1::text[]) ORDER BY key",
              [["emails", "folders", "mailboxes"]],
            )
          ).rows,
      );
      expect(rows.map((row) => row.key)).toEqual(["emails", "folders", "mailboxes"]);
    }
  });

  it("adds the Events.files / Files.events relation to every tenant in its own scope (issue #1588)", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    const pairOf = async (tenantId: string) => {
      const { rows } = await adminPool.query<{ owner_module_id: string; key: string; target: string | null }>(
        `SELECT d.owner_module_id, p.key,
                (SELECT t.owner_module_id || ':' || t.tenant_id FROM databases t
                  WHERE t.id = (p.config->>'targetDatabaseId')::uuid) AS target
           FROM properties p JOIN databases d ON d.id = p.database_id
          WHERE d.tenant_id = $1 AND p.type = 'relation'
            AND ((d.owner_module_id = 'events' AND p.key = 'files') OR (d.owner_module_id = 'files' AND p.key = 'events'))
          ORDER BY d.owner_module_id`,
        [tenantId],
      );
      return rows;
    };
    for (const tenantId of [zero, b]) {
      const pair = await pairOf(tenantId);
      expect(pair).toHaveLength(2);
      // Reverts the tenant to the pre-#1588 seed; the locked schemas have no public removal path.
      const definitions = await adminPool.query<{ id: string }>(
        `SELECT DISTINCT (p.config->>'relationDefinitionId') AS id FROM properties p JOIN databases d ON d.id = p.database_id
          WHERE d.tenant_id = $1 AND ((d.owner_module_id = 'events' AND p.key = 'files')
             OR (d.owner_module_id = 'files' AND p.key = 'events'))`,
        [tenantId],
      );
      const ids = definitions.rows.map((row) => row.id);
      await adminPool.query("DELETE FROM properties WHERE config->>'relationDefinitionId' = ANY($1::text[])", [ids]);
      await adminPool.query("DELETE FROM relation_definitions WHERE id = ANY($1::uuid[])", [ids]);
      expect(await pairOf(tenantId)).toEqual([]);
    }

    await runCutovers(dataPool);

    for (const tenantId of [zero, b]) {
      expect(await pairOf(tenantId)).toEqual([
        { owner_module_id: "events", key: "files", target: `files:${tenantId}` },
        { owner_module_id: "files", key: "events", target: `events:${tenantId}` },
      ]);
    }
  });

  it("is idempotent: a second call changes no row", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    await runCutovers(dataPool);
    const before = await snapshot();

    await runCutovers(dataPool);

    expect(await snapshot()).toEqual(before);
  });

  it("creates only the missing heartbeat when just one tenant lacks it", async () => {
    await seedOldShape(zero, { keepHeartbeat: true });
    await seedOldShape(b);
    const zeroBefore = (await readState(zero)).heartbeats;
    expect(zeroBefore).toHaveLength(1);

    await runCutovers(dataPool);

    expect((await readState(zero)).heartbeats).toEqual(zeroBefore);
    await expectUpgraded(b);
  });

  it("leaves a deleting tenant untouched", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    await adminPool.query("UPDATE tenants SET status = 'deleting' WHERE id = $1", [b]);
    const bBefore = await readState(b);

    await runCutovers(dataPool);

    await expectUpgraded(zero);
    expect(await readState(b)).toEqual(bBefore);
  });

  it("upgrades the other tenants when one tenant's cutover throws, then rejects naming it", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    const { transcriptsId } = await readState(b);
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION test_fail_b_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.database_id = '${transcriptsId}' THEN RAISE EXCEPTION 'test cutover failure'; END IF;
        RETURN NEW;
      END $$`);
    await adminPool.query(
      "CREATE TRIGGER test_fail_b_cutover BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION test_fail_b_cutover()",
    );
    try {
      const error = await runCutovers(dataPool).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain(b);
      expect((error as AggregateError).message).not.toContain(zero);
      expect((error as AggregateError).errors).toHaveLength(1);
    } finally {
      await adminPool.query("DROP TRIGGER test_fail_b_cutover ON properties");
      await adminPool.query("DROP FUNCTION test_fail_b_cutover()");
    }

    await expectUpgraded(zero);
    expect((await readState(b)).statusOptions).not.toContain("error");
  });

  it("continues guidance cutover for another tenant when one tenant's guidance insertion fails", async () => {
    // Fix the existing tenant timestamps so the real runner visits the failing tenant before the healthy one.
    await adminPool.query(
      "UPDATE tenants SET created_at = CASE WHEN id = $1 THEN '2000-01-01T00:00:00Z'::timestamptz ELSE '2001-01-01T00:00:00Z'::timestamptz END WHERE id = ANY($2::uuid[])",
      [b, [b, zero]],
    );
    const ordering = await adminPool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE status IN ('provisioning','active','suspended') ORDER BY created_at, id",
    );
    expect(ordering.rows.map((row) => row.id)).toEqual([b, zero]);
    await runInTenant(zero, () => seedSystem(dataPool));
    await runInTenant(b, () => seedSystem(dataPool));
    const ownerA = await createUser(adminPool, {
      tenantId: zero,
      email: "guidance-a@example.test",
      passwordHash: "unused",
    });
    const ownerB = await createUser(adminPool, {
      tenantId: b,
      email: "guidance-b@example.test",
      passwordHash: "unused",
    });
    async function addProject(tenantId: string, text: string): Promise<string> {
      return runInTenant(tenantId, () =>
        withTransaction(dataPool, async (client) => {
          const projects = await getDatabaseByModuleId(client, "projects");
          if (!projects) throw new Error("missing Projects database");
          return (
            await itemsStore.insertItem(client, {
              databaseId: projects.id,
              properties: { name: "Guidance fixture", agents: text },
            })
          ).id;
        }),
      );
    }
    const projectA = await addProject(zero, "Purpose: healthy tenant");
    const projectB = await addProject(b, "Purpose: failing tenant");
    const ddl = await adminPool.query<{ sql: string }>(
      `SELECT format($fn$CREATE FUNCTION batch20_fail_guidance() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN IF NEW.owner_user_id = %L::uuid THEN RAISE EXCEPTION 'batch20 guidance failure'; END IF; RETURN NEW; END
        $body$$fn$, $1::text) AS sql`,
      [ownerB.id],
    );
    const sql = ddl.rows[0]?.sql;
    if (!sql) throw new Error("missing trigger function DDL");
    let functionCreated = false;
    let triggerCreated = false;
    let primary: unknown;
    try {
      await adminPool.query(sql);
      functionCreated = true;
      await adminPool.query(
        "CREATE TRIGGER batch20_fail_guidance BEFORE INSERT ON project_agent_guidance FOR EACH ROW EXECUTE FUNCTION batch20_fail_guidance()",
      );
      triggerCreated = true;
      const error: unknown = await runCutovers(dataPool).then(
        () => null,
        (caught: unknown) => caught,
      );
      if (!(error instanceof AggregateError)) throw new Error("expected tenant aggregate failure");
      expect(error.message).toContain(b);
      expect(error.message).not.toContain(zero);
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0]).toMatchObject({ message: "batch20 guidance failure" });
      const healthy = await runInTenant(zero, () =>
        withTransaction(dataPool, async (client) => ({
          guidance: (
            await client.query<{ owner_user_id: string; markdown: string }>(
              "SELECT owner_user_id, markdown FROM project_agent_guidance WHERE project_item_id = $1",
              [projectA],
            )
          ).rows,
          heartbeat: (
            await client.query<{ enabled: boolean }>(
              "SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
              [projectA],
            )
          ).rows,
        })),
      );
      expect(healthy).toEqual({
        guidance: [{ owner_user_id: ownerA.id, markdown: "## Purpose\nhealthy tenant\n" }],
        heartbeat: [{ enabled: true }],
      });
      const failed = await runInTenant(b, () =>
        withTransaction(dataPool, async (client) => ({
          guidance: (await client.query<{ id: string }>("SELECT project_item_id AS id FROM project_agent_guidance"))
            .rows,
          heartbeat: (
            await client.query<{ id: string }>(
              "SELECT id FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
              [projectB],
            )
          ).rows,
        })),
      );
      expect(failed).toEqual({ guidance: [], heartbeat: [] });
    } catch (error) {
      primary = error;
    }
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (triggerCreated) await adminPool.query("DROP TRIGGER batch20_fail_guidance ON project_agent_guidance");
      },
      async () => {
        if (functionCreated) await adminPool.query("DROP FUNCTION batch20_fail_guidance()");
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primary === undefined ? cleanupErrors : [primary, ...cleanupErrors],
        "Guidance fixture cleanup failed",
        { cause: primary },
      );
    if (primary instanceof Error) throw primary;
    if (primary !== undefined) throw new Error("Guidance fixture failed", { cause: primary });
  });

  it("refuses the owner pool and writes nothing", async () => {
    await seedOldShape(zero);
    await seedOldShape(b);
    const before = await snapshot();

    await expect(runCutovers(adminPool)).rejects.toThrow(/row-level security applies/);

    expect(await snapshot()).toEqual(before);
  });
});

describe("property defaults tenant cutover", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });
  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("upgrades the six properties per tenant, preserves config and existing defaults, and is idempotent", async () => {
    await resetDatabase(adminPool);
    const zero = getTenantZeroId();
    const other = await createTestTenant(adminPool);
    for (const tenant of [zero, other]) {
      await runInTenant(tenant, async () => {
        await seedSystem(dataPool, createViewTypeRegistry());
        // Simulates a schema-locked catalog created before defaults existed; unavailable via the public writer.
        await dataPool.query(`UPDATE properties SET config = config - 'default'`);
        await dataPool.query(`UPDATE properties SET config = config || '{"includeTime":false}'::jsonb
          WHERE key = 'date' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'files')`);
      });
    }
    await runInTenant(other, async () => {
      // A pre-existing explicit config default, including null, must not be replaced by the cutover.
      await dataPool.query(`UPDATE properties SET config = config || '{"default":null}'::jsonb
        WHERE key = 'status' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'projects')`);
    });

    const defaults = (tenant: string) =>
      runInTenant(tenant, async () => {
        const { rows } = await dataPool.query<{ module_id: string; key: string; config: Record<string, unknown> }>(
          `SELECT d.owner_module_id AS module_id, p.key, p.config FROM properties p JOIN databases d ON d.id = p.database_id
         WHERE p.config ? 'default' ORDER BY module_id, p.key`,
        );
        return rows;
      });
    await runCutovers(dataPool);
    const expected = [
      { module_id: "areas", key: "active", value: true },
      { module_id: "books", key: "status", value: "toRead" },
      { module_id: "files", key: "date", value: "today" },
      { module_id: "movies", key: "status", value: "planned" },
      { module_id: "projects", key: "status", value: "inProgress" },
      { module_id: "tasks", key: "status", value: "notDone" },
    ];
    for (const tenant of [zero, other]) {
      const rows = await defaults(tenant);
      expect(rows.map((r) => ({ module_id: r.module_id, key: r.key, value: r.config.default }))).toEqual(
        expected.map((r) => (tenant === other && r.module_id === "projects" ? { ...r, value: null } : r)),
      );
      expect(rows.find((r) => r.module_id === "files")?.config.includeTime).toBe(false);
      expect(rows.find((r) => r.module_id === "tasks")?.config.options).toEqual([
        { key: "notDone" },
        { key: "done" },
        { key: "wontDo" },
        { key: "missed" },
      ]);
    }
    const before = await snapshot();
    await runCutovers(dataPool);
    expect(await snapshot()).toEqual(before);
  });

  it("skips a missing database and a missing property", async () => {
    await resetDatabase(adminPool);
    const zero = getTenantZeroId();
    await runInTenant(zero, async () => {
      await seedSystem(dataPool, createViewTypeRegistry());
      // Simulate incomplete legacy schema; locked properties/databases cannot be removed through the public writer.
      await dataPool.query(`UPDATE properties SET config = config - 'default'`);
      await dataPool.query(`DELETE FROM properties WHERE key = 'active'
        AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'areas')`);
      await dataPool.query(`UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'books'`);
    });
    await runCutovers(dataPool);
    await runInTenant(zero, async () => {
      const { rows } = await dataPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM properties WHERE config ? 'default'`,
      );
      expect(rows[0]?.n).toBe(4);
    });
  });
});

/** Card-state properties issue #1451 adds to Processing proposals, with their types. */
const CARD_STATE_TYPES: Record<string, string> = {
  aiProposal: "json",
  userOverrides: "json",
  userEditedKeys: "json",
  aiVersion: "number",
  reason: "text",
  recognizedTypeId: "text",
  typeCandidates: "json",
  candidates: "json",
  invalidReason: "json",
  referencedItemIds: "json",
  results: "json",
  context: "json",
};
const CARD_STATE_KEYS = Object.keys(CARD_STATE_TYPES);
const PRE_CARD_STATE_STATUS_OPTIONS = ["needsClarification", "proposed", "confirmed", "rejected", "invalid"];
const CARD_STATE_STATUS_OPTIONS = [...PRE_CARD_STATE_STATUS_OPTIONS, "computing", "computeFailed"];

interface ProposalPropertyRow {
  key: string;
  name: string;
  type: string;
  owner: string;
  owner_process: string | null;
  /** The stored config, except a relation's, which is replaced by the owner module of its target. */
  config: { options?: Array<{ key: string }>; target?: string | null };
}

async function proposalsDatabaseId(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'processingProposals'",
    );
    if (!rows[0]) throw new Error("Database 'processingProposals' was not seeded");
    return rows[0].id;
  });
}

/** Seeds the tenant, then rebuilds its Processing proposals database in the shape it had before issue #1451. */
async function seedPreCardStateShape(tenantId: string): Promise<string> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const databaseId = await proposalsDatabaseId(tenantId);
  // Direct SQL is the fixture: the public property writer refuses this schema-locked database, and a
  // populated install was left in exactly this shape before the card-state properties existed.
  await adminPool.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
    databaseId,
    CARD_STATE_KEYS,
  ]);
  await adminPool.query(
    `UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE database_id = $1 AND key = 'status'`,
    [databaseId, JSON.stringify(PRE_CARD_STATE_STATUS_OPTIONS.map((key) => ({ key })))],
  );
  return databaseId;
}

/**
 * Writes a card through the item store. The generic writer refuses system-owned keys, and the
 * producers of these cards are later issues, so the store stands in for them, as inboxPipeline.test.ts does.
 */
async function insertCard(tenantId: string, databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(tenantId, async () => {
    const item = await withTransaction(dataPool, (client) => itemsStore.insertItem(client, { databaseId, properties }));
    return item.id;
  });
}

async function cardsByFingerprint(tenantId: string, databaseId: string): Promise<Map<string, Record<string, unknown>>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 ORDER BY id",
      [databaseId],
    );
    return new Map(rows.map((row) => [String(row.properties.fingerprint), row.properties]));
  });
}

/**
 * The Processing proposals properties of a tenant, with each relation's generated ids replaced by the
 * owner module of its target database. Two tenants built the same way differ only in those ids, so
 * this compares what the schema says, not the uuids it was created with.
 */
async function proposalShape(tenantId: string): Promise<ProposalPropertyRow[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<ProposalPropertyRow>(
      `SELECT p.key, p.name, p.type, p.owner, p.owner_process,
              CASE WHEN p.type = 'relation' THEN jsonb_build_object('target', target.owner_module_id)
                   ELSE p.config END AS config
         FROM properties p
         JOIN databases d ON d.id = p.database_id
         LEFT JOIN databases target ON target.id = (p.config ->> 'targetDatabaseId')::uuid
        WHERE d.owner_module_id = 'processingProposals'
        ORDER BY p.key`,
    );
    return rows;
  });
}

/** The rows a cutover may change for one database: its properties and its items, read as the owner. */
async function proposalSnapshot(databaseId: string): Promise<unknown[]> {
  const { rows: properties } = await adminPool.query<{ row: unknown }>(
    "SELECT to_jsonb(t) AS row FROM properties t WHERE database_id = $1 ORDER BY id",
    [databaseId],
  );
  const { rows: items } = await adminPool.query<{ row: unknown }>(
    "SELECT to_jsonb(t) AS row FROM items t WHERE database_id = $1 ORDER BY id",
    [databaseId],
  );
  return [properties, items];
}

describe("processing proposals card-state tenant cutover (issue #1451)", () => {
  let zero: string;
  let b: string;
  let chokePoint: ChokePoint;

  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    chokePoint = createChokePoint(dataPool, undefined, createViewTypeRegistry());
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    b = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  /** Tenant b as an existing install leaves it: the pre-#1451 shape with five cards, one per case the backfill decides on. */
  async function populatedTenant(): Promise<string> {
    const databaseId = await seedPreCardStateShape(b);
    await insertCard(b, databaseId, {
      kind: "inbox",
      fingerprint: "with-proposal",
      proposal: { target: "tasks" },
      history: [],
      status: "proposed",
    });
    await insertCard(b, databaseId, {
      kind: "inbox",
      fingerprint: "without-proposal",
      history: [],
      status: "needsClarification",
    });
    await insertCard(b, databaseId, {
      kind: "inbox",
      fingerprint: "null-proposal",
      proposal: null,
      history: [],
      status: "needsClarification",
    });
    await insertCard(b, databaseId, {
      kind: "inbox",
      fingerprint: "ai-already-set",
      proposal: { target: "people" },
      aiProposal: { target: "areas" },
      history: [],
      status: "proposed",
    });
    await insertCard(b, databaseId, {
      kind: "inbox",
      fingerprint: "ai-null",
      proposal: { target: "events" },
      aiProposal: null,
      history: [],
      status: "proposed",
    });
    return databaseId;
  }

  it("adds every card-state property, system-owned, and both status options to a populated tenant", async () => {
    await populatedTenant();

    await runCutovers(dataPool);

    const shape = await proposalShape(b);
    for (const [key, type] of Object.entries(CARD_STATE_TYPES)) {
      expect(shape.find((row) => row.key === key)).toMatchObject({ type, owner: "system", owner_process: null });
    }
    expect(shape.find((row) => row.key === "status")?.config.options?.map((option) => option.key)).toEqual(
      CARD_STATE_STATUS_OPTIONS,
    );
  });

  it("leaves a populated tenant with the same Processing proposals shape as a fresh seed", async () => {
    await runInTenant(zero, () => seedSystem(dataPool, createViewTypeRegistry()));
    await populatedTenant();

    await runCutovers(dataPool);

    expect(await proposalShape(b)).toEqual(await proposalShape(zero));
  });

  it("backfills aiProposal from proposal only where proposal is set and aiProposal is empty", async () => {
    const databaseId = await populatedTenant();

    await runCutovers(dataPool);

    const cards = await cardsByFingerprint(b, databaseId);
    expect(cards.get("with-proposal")?.aiProposal).toEqual({ target: "tasks" });
    expect(cards.get("with-proposal")?.proposal).toEqual({ target: "tasks" });
    expect(cards.get("ai-null")?.aiProposal).toEqual({ target: "events" });
    expect(cards.get("ai-already-set")?.aiProposal).toEqual({ target: "areas" });
    expect(cards.get("without-proposal")).not.toHaveProperty("aiProposal");
    expect(cards.get("null-proposal")).not.toHaveProperty("aiProposal");
  });

  it("preserves extra status option data while appending the missing options", async () => {
    const databaseId = await seedPreCardStateShape(b);
    await adminPool.query("UPDATE properties SET config = $2::jsonb WHERE database_id = $1 AND key = 'status'", [
      databaseId,
      JSON.stringify({ options: [{ key: "proposed", color: "blue" }], custom: "keep" }),
    ]);
    await runCutovers(dataPool);
    const { rows } = await adminPool.query<{ config: unknown }>(
      "SELECT config FROM properties WHERE database_id = $1 AND key = 'status'",
      [databaseId],
    );
    expect(rows).toEqual([
      {
        config: {
          options: [{ key: "proposed", color: "blue" }, { key: "computing" }, { key: "computeFailed" }],
          custom: "keep",
        },
      },
    ]);
  });

  it("adds the options when a valid status config has none", async () => {
    const databaseId = await seedPreCardStateShape(b);
    await adminPool.query("UPDATE properties SET config = '{}'::jsonb WHERE database_id = $1 AND key = 'status'", [
      databaseId,
    ]);
    await runCutovers(dataPool);
    const { rows } = await adminPool.query<{ config: unknown }>(
      "SELECT config FROM properties WHERE database_id = $1 AND key = 'status'",
      [databaseId],
    );
    expect(rows).toEqual([{ config: { options: [{ key: "computing" }, { key: "computeFailed" }] } }]);
  });

  it.each([{ options: "invalid" }, { options: [{ key: 42 }] }, null])(
    "refuses malformed status config %j and rolls back the tenant cutover",
    async (config) => {
      const databaseId = await seedPreCardStateShape(b);
      await adminPool.query("UPDATE properties SET config = $2::jsonb WHERE database_id = $1 AND key = 'status'", [
        databaseId,
        JSON.stringify(config),
      ]);
      const before = await proposalSnapshot(databaseId);
      await expect(runCutovers(dataPool)).rejects.toBeInstanceOf(AggregateError);
      expect(await proposalSnapshot(databaseId)).toEqual(before);
    },
  );

  it("a second run changes no property, option or item", async () => {
    const databaseId = await populatedTenant();
    await runCutovers(dataPool);
    const proposalBefore = await proposalSnapshot(databaseId);
    const before = await snapshot();

    await runCutovers(dataPool);

    expect(await proposalSnapshot(databaseId)).toEqual(proposalBefore);
    expect(await snapshot()).toEqual(before);
  });

  it("does nothing in a tenant without a Processing proposals database", async () => {
    await seedPreCardStateShape(b);
    await runInTenant(b, () =>
      dataPool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'processingProposals'"),
    );
    const before = await snapshot();

    await runCutovers(dataPool);

    expect(await snapshot()).toEqual(before);
  });

  it("refuses a generic item update to any card-state property and writes nothing", async () => {
    const databaseId = await seedPreCardStateShape(b);
    const cardId = await insertCard(b, databaseId, {
      kind: "inbox",
      fingerprint: "card",
      history: [],
      status: "proposed",
    });
    await runCutovers(dataPool);
    const before = await proposalSnapshot(databaseId);

    // The PATCH route reaches this same choke-point call with no allowedSystemKeys, so the owner check
    // is what refuses each key here.
    await runInTenant(b, async () => {
      for (const key of CARD_STATE_KEYS) {
        await expect(
          chokePoint.updateItem({ databaseId, itemId: cardId, propertiesPatch: { [key]: "written by a client" } }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
    });

    expect(await proposalSnapshot(databaseId)).toEqual(before);
  });

  it("fails and names the tenant when its Processing proposals database has no status property, rolling back its shape", async () => {
    const databaseId = await seedPreCardStateShape(b);
    await adminPool.query("DELETE FROM properties WHERE database_id = $1 AND key = 'status'", [databaseId]);

    const error = await runCutovers(dataPool).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain(b);
    expect((error as AggregateError).message).not.toContain(zero);
    expect((await proposalShape(b)).map((row) => row.key)).not.toContain("aiProposal");
  });
});

/**
 * Seeds the tenant, then sets its Emails.senderPeople back to one_to_many, the shape a populated install
 * was seeded with before issue #1457. Direct SQL is the fixture: the seed now declares many_to_many.
 */
async function seedOneToManySender(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  await adminPool.query(
    `UPDATE relation_definitions SET cardinality = 'one_to_many'
      WHERE tenant_id = $1 AND id IN (
        SELECT rd.id FROM relation_definitions rd
          JOIN properties p ON p.id = rd.property_id_a
          JOIN databases d ON d.id = p.database_id
         WHERE d.owner_module_id = 'emails' AND p.key = 'senderPeople' AND d.tenant_id = $1)`,
    [tenantId],
  );
}

async function senderCardinality(tenantId: string): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ cardinality: string }>(
      `SELECT rd.cardinality FROM relation_definitions rd
         JOIN properties p ON p.id = rd.property_id_a
         JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'emails' AND p.key = 'senderPeople'`,
    );
    return rows[0]?.cardinality ?? null;
  });
}

/** Every relation definition of one tenant, read as the owner, so a test can see a tenant the cutover did not touch. */
async function relationDefinitions(tenantId: string): Promise<Array<{ id: string; cardinality: string }>> {
  const { rows } = await adminPool.query<{ id: string; cardinality: string }>(
    "SELECT id, cardinality FROM relation_definitions WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );
  return rows;
}

describe("emails senderPeople cardinality tenant cutover (issue #1457)", () => {
  let zero: string;
  let b: string;

  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    b = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("switches a populated tenant's senderPeople to many_to_many in every tenant", async () => {
    await seedOneToManySender(zero);
    await seedOneToManySender(b);

    await runCutovers(dataPool);

    expect(await senderCardinality(zero)).toBe("many_to_many");
    expect(await senderCardinality(b)).toBe("many_to_many");
  });

  it("is idempotent: a second call changes no row", async () => {
    await seedOneToManySender(zero);
    await seedOneToManySender(b);
    await runCutovers(dataPool);
    const before = await snapshot();

    await runCutovers(dataPool);

    expect(await snapshot()).toEqual(before);
    expect(await senderCardinality(b)).toBe("many_to_many");
  });

  it("does nothing in a tenant without an Emails database", async () => {
    await seedOneToManySender(zero);
    await seedOneToManySender(b);
    await runInTenant(b, () =>
      dataPool.query("UPDATE databases SET owner_module_id = NULL, key = NULL WHERE owner_module_id = 'emails'"),
    );
    const bBefore = await relationDefinitions(b);

    await runCutovers(dataPool);

    expect(await senderCardinality(b)).toBeNull();
    expect(await relationDefinitions(b)).toEqual(bBefore);
    expect(bBefore.map((row) => row.cardinality)).toContain("one_to_many");
    expect(await senderCardinality(zero)).toBe("many_to_many");
  });

  it("fails and names the tenant when its Emails database has no senderPeople relation, and still upgrades the other tenant", async () => {
    await seedOneToManySender(zero);
    await seedOneToManySender(b);
    await adminPool.query(
      `DELETE FROM relation_definitions WHERE tenant_id = $1 AND id IN (
         SELECT rd.id FROM relation_definitions rd
           JOIN properties p ON p.id = rd.property_id_a
           JOIN databases d ON d.id = p.database_id
          WHERE d.owner_module_id = 'emails' AND p.key = 'senderPeople' AND d.tenant_id = $1)`,
      [b],
    );
    await adminPool.query(
      `DELETE FROM properties WHERE key = 'senderPeople' AND database_id IN (
         SELECT id FROM databases WHERE owner_module_id = 'emails' AND tenant_id = $1)`,
      [b],
    );

    const error = await runCutovers(dataPool).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain(b);
    expect((error as AggregateError).message).not.toContain(zero);
    expect((error as AggregateError).errors).toHaveLength(1);
    expect(await senderCardinality(zero)).toBe("many_to_many");
  });
});

describe("rating filter presets tenant cutover (issue #1622)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });
  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  const ratingConfigs = (tenant: string) =>
    runInTenant(tenant, async () => {
      const { rows } = await dataPool.query<{ module_id: string; config: Record<string, unknown> }>(
        `SELECT d.owner_module_id AS module_id, p.config FROM properties p JOIN databases d ON d.id = p.database_id
         WHERE p.key = 'rating' AND d.owner_module_id = ANY('{books,movies}') ORDER BY d.owner_module_id`,
      );
      return Object.fromEntries(rows.map((row) => [row.module_id, row.config]));
    });

  it("adds the presets to existing tenants, keeps other config and a tenant's own presets, and is idempotent", async () => {
    await resetDatabase(adminPool);
    const zero = getTenantZeroId();
    const other = await createTestTenant(adminPool);
    const own = { filterPresets: [{ value: 10, op: "gte", labelKey: "own.key" }] };
    for (const tenant of [zero, other]) {
      await runInTenant(tenant, async () => {
        await seedSystem(dataPool, createViewTypeRegistry());
        // A tenant seeded before issue #1622: the locked Library schemas cannot change config through the writer.
        await dataPool.query(
          `UPDATE properties SET config = (config - 'filterPresets' - 'emptyPreset') || '{"default":0}'::jsonb
           WHERE key = 'rating' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = ANY('{books,movies}'))`,
        );
      });
    }
    await runInTenant(other, () =>
      dataPool.query(
        `UPDATE properties SET config = config || $1::jsonb
         WHERE key = 'rating' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'books')`,
        [JSON.stringify(own)],
      ),
    );

    await runCutovers(dataPool);
    const seeded = (databaseKey: "books" | "movies") => ({
      default: 0,
      filterPresets: [5, 4, 3].map((value) => ({
        value,
        op: "gte",
        labelKey: `property.${databaseKey}.rating.preset.${value}`,
      })),
      emptyPreset: { labelKey: `property.${databaseKey}.rating.preset.none`, matchZero: true },
    });
    expect(await ratingConfigs(zero)).toEqual({ books: seeded("books"), movies: seeded("movies") });
    expect(await ratingConfigs(other)).toEqual({ books: { default: 0, ...own }, movies: seeded("movies") });

    const before = await snapshot();
    await runCutovers(dataPool);
    expect(await snapshot()).toEqual(before);
  });

  it("skips a missing Movies database and still adds the Books presets", async () => {
    await resetDatabase(adminPool);
    const zero = getTenantZeroId();
    const movies = await runInTenant(zero, async () => {
      await seedSystem(dataPool, createViewTypeRegistry());
      const database = await withTransaction(dataPool, (client) => getDatabaseByModuleId(client, "movies"));
      if (!database) throw new Error("Movies database missing");
      // A tenant installed before the Movies database had its module id: the cutover cannot find it by module.
      const detached = await dataPool.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [database.id]);
      expect(detached.rowCount).toBe(1);
      await dataPool.query(
        `UPDATE properties SET config = config - 'filterPresets' - 'emptyPreset'
         WHERE key = 'rating' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'books')`,
      );
      return database.id;
    });
    const moviesRating = () =>
      runInTenant(zero, async () => {
        const { rows } = await dataPool.query<{ config: Record<string, unknown> }>(
          "SELECT config FROM properties WHERE database_id = $1 AND key = 'rating'",
          [movies],
        );
        return rows;
      });
    const moviesBefore = await moviesRating();
    expect(moviesBefore).toHaveLength(1);
    await runInTenant(zero, () => runRatingFilterPresetsCutoverMigration(dataPool));
    const configs = await ratingConfigs(zero);
    expect(Object.keys(configs)).toEqual(["books"]);
    expect(configs.books).toMatchObject({ filterPresets: expect.any(Array), emptyPreset: expect.any(Object) });
    expect(await moviesRating()).toEqual(moviesBefore);
  });

  it("skips a missing rating property", async () => {
    await resetDatabase(adminPool);
    const zero = getTenantZeroId();
    await runInTenant(zero, async () => {
      await seedSystem(dataPool, createViewTypeRegistry());
      // Incomplete legacy schema; a locked property cannot be removed through the public writer.
      await dataPool.query(
        `DELETE FROM properties WHERE key = 'rating' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'movies')`,
      );
      await dataPool.query(
        `UPDATE properties SET config = config - 'filterPresets' - 'emptyPreset'
         WHERE key = 'rating' AND database_id IN (SELECT id FROM databases WHERE owner_module_id = 'books')`,
      );
    });
    await runCutovers(dataPool);
    const configs = await ratingConfigs(zero);
    expect(Object.keys(configs)).toEqual(["books"]);
    expect(configs.books).toMatchObject({ filterPresets: expect.any(Array) });
  });
});
