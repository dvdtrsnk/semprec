import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  bindToTenantZero,
  createTenantZeroUser,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";

let pool: Pool;
let chokePoint: ChokePoint;
let typesId: string;
let userId: string;

/** The three writers an Inbox item type can come from, each passed to the choke point as the application service passes it. */
const SOURCES = ["REST", "an agent tool", "/mcp"] as const;
type Source = (typeof SOURCES)[number];

const AGENT_RUN_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_PROJECT_ITEM_ID = "00000000-0000-4000-8000-000000000002";

interface WriterArgs {
  actingUserId: string;
  humanWriterUserId?: string;
  writer: WriterIdentity;
}

function writerArgsFor(source: Source): WriterArgs {
  if (source === "REST") {
    return { actingUserId: userId, humanWriterUserId: userId, writer: { writerKind: "user" } };
  }
  if (source === "an agent tool") {
    return {
      actingUserId: userId,
      writer: {
        writerKind: "agent",
        agentRunId: AGENT_RUN_ID,
        agentProjectItemId: AGENT_PROJECT_ITEM_ID,
        onBehalfOfUserId: userId,
      },
    };
  }
  return { actingUserId: userId, writer: { writerKind: "agent", onBehalfOfUserId: userId } };
}

function createType(source: Source, properties: Record<string, unknown>) {
  const { actingUserId, humanWriterUserId, writer } = writerArgsFor(source);
  return chokePoint.createItem(
    { databaseId: typesId, properties: { name: "Type", emoji: "🧪", ...properties } },
    actingUserId,
    humanWriterUserId,
    writer,
  );
}

function patchType(source: Source, itemId: string, propertiesPatch: Record<string, unknown>) {
  const { actingUserId, humanWriterUserId, writer } = writerArgsFor(source);
  return chokePoint.updateItem(
    { databaseId: typesId, itemId, propertiesPatch },
    actingUserId,
    humanWriterUserId,
    writer,
  );
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function countTypes(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    typesId,
  ]);
  if (!rows[0]) throw new Error("count query returned no row");
  return rows[0].n;
}

/**
 * Writes a `targetDatabase` straight into the stored row, the way a type stored before this rule existed
 * looks. The choke point refuses that state now, so the row is the only place a test can put it.
 */
async function storeTargetDirectly(itemId: string, target: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text))
     WHERE database_id = $1 AND id = $2
     RETURNING id`,
    [typesId, itemId, target],
  );
  if (rows.length !== 1) throw new Error(`Inbox item type ${itemId} was not found`);
}

/** Each refusal is a 400 `validation_failed` that names the failing field, as the Acceptance criteria state. */
function refusalFor(field: "processingMethod" | "targetDatabase") {
  return { status: 400, code: "validation_failed", details: { field } };
}

const INVALID_CREATES: ReadonlyArray<
  readonly [label: string, properties: Record<string, unknown>, field: "processingMethod" | "targetDatabase"]
> = [
  [
    "a 'database' type targeting journal",
    { processingMethod: "database", targetDatabase: "journal" },
    "targetDatabase",
  ],
  [
    "a 'database' type targeting transcripts",
    { processingMethod: "database", targetDatabase: "transcripts" },
    "targetDatabase",
  ],
  [
    "a 'database' type targeting an unknown database",
    { processingMethod: "database", targetDatabase: "nonsense" },
    "targetDatabase",
  ],
  [
    "a 'database' type whose target is not a string",
    { processingMethod: "database", targetDatabase: 7 },
    "targetDatabase",
  ],
  ["a 'database' type without a target", { processingMethod: "database" }, "targetDatabase"],
  [
    "a 'pageContent' type with a target",
    { processingMethod: "pageContent", targetDatabase: "tasks" },
    "targetDatabase",
  ],
  ["a target without a processing method", { targetDatabase: "tasks" }, "targetDatabase"],
  ["an unknown processing method", { processingMethod: "journalEntry" }, "processingMethod"],
];

/** The eight system databases a 'database' type may target: the ten system databases without journal and transcripts. */
const ACCEPTED_TARGETS = [
  "areas",
  "projects",
  "tasks",
  "people",
  "files",
  "events",
  "healthRecords",
  "companies",
] as const;

describe("Inbox item type write hook: processingMethod and targetDatabase are checked on every write (issue #1436)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    const computedKeyRegistry = createComputedKeyRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry, computedKeyRegistry);
    chokePoint = bindToTenantZero(createChokePoint(pool, computedKeyRegistry, viewTypeRegistry));
    typesId = await databaseIdFor("inboxItemTypes");
    userId = (await createTenantZeroUser(pool)).id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe.each(SOURCES)("written through %s", (source) => {
    describe("creates", () => {
      it.each(INVALID_CREATES)("refuses %s and leaves no row", async (_label, properties, field) => {
        await expect(createType(source, properties)).rejects.toMatchObject(refusalFor(field));
        expect(await countTypes()).toBe(0);
      });

      it.each(ACCEPTED_TARGETS)("accepts a 'database' type targeting %s", async (target) => {
        const type = await createType(source, { processingMethod: "database", targetDatabase: target });
        expect(type.properties).toMatchObject({ processingMethod: "database", targetDatabase: target });
      });

      it("accepts a 'pageContent' type with no target", async () => {
        const thought = await createType(source, { processingMethod: "pageContent" });
        expect(thought.properties.processingMethod).toBe("pageContent");
        expect(thought.properties.targetDatabase).toBeUndefined();
      });

      it("accepts a type with neither a processing method nor a target", async () => {
        const bare = await createType(source, {});
        expect(bare.properties.processingMethod).toBeUndefined();
        expect(bare.properties.targetDatabase).toBeUndefined();
      });
    });

    describe("updates", () => {
      let itemId: string;

      beforeEach(async () => {
        itemId = (await createType(source, { processingMethod: "database", targetDatabase: "tasks" })).id;
      });

      it("refuses a patch that moves the target to journal and keeps the stored pair", async () => {
        await expect(patchType(source, itemId, { targetDatabase: "journal" })).rejects.toMatchObject(
          refusalFor("targetDatabase"),
        );
        const stored = await chokePoint.getItem(typesId, itemId);
        expect(stored?.properties).toMatchObject({ processingMethod: "database", targetDatabase: "tasks" });
      });

      it("refuses a patch that turns a 'database' type into a 'pageContent' type while its target stays set", async () => {
        await expect(patchType(source, itemId, { processingMethod: "pageContent" })).rejects.toMatchObject(
          refusalFor("targetDatabase"),
        );
        const stored = await chokePoint.getItem(typesId, itemId);
        expect(stored?.properties).toMatchObject({ processingMethod: "database", targetDatabase: "tasks" });
      });

      it("refuses a patch that sets an unknown processing method", async () => {
        await expect(patchType(source, itemId, { processingMethod: "journalEntry" })).rejects.toMatchObject(
          refusalFor("processingMethod"),
        );
      });

      it("accepts a patch that switches the target to another accepted database", async () => {
        const updated = await patchType(source, itemId, { targetDatabase: "events" });
        expect(updated.properties).toMatchObject({ processingMethod: "database", targetDatabase: "events" });
      });

      it("accepts a patch that switches to 'pageContent' and clears the target in the same write", async () => {
        const updated = await patchType(source, itemId, { processingMethod: "pageContent", targetDatabase: null });
        expect(updated.properties).toMatchObject({ processingMethod: "pageContent", targetDatabase: null });
      });

      it("accepts a rename of a type already stored with a target that is no longer allowed", async () => {
        await storeTargetDirectly(itemId, "journal");

        const renamed = await patchType(source, itemId, { name: "Renamed" });
        expect(renamed.properties).toMatchObject({
          name: "Renamed",
          processingMethod: "database",
          targetDatabase: "journal",
        });
      });

      it("refuses a write that sets the stored invalid pair again", async () => {
        await storeTargetDirectly(itemId, "journal");

        await expect(
          patchType(source, itemId, { processingMethod: "database", targetDatabase: "journal" }),
        ).rejects.toMatchObject(refusalFor("targetDatabase"));
      });
    });
  });

  it("does not check a write to another database that happens to have the same property keys", async () => {
    const other = await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const database = await databasesStore.createDatabase(client, { name: "Other" });
        await propertiesStore.createProperty(client, {
          databaseId: database.id,
          key: "processingMethod",
          name: "Processing method",
          type: "text",
        });
        await propertiesStore.createProperty(client, {
          databaseId: database.id,
          key: "targetDatabase",
          name: "Target database",
          type: "text",
        });
        return database;
      }),
    );

    const item = await chokePoint.createItem(
      { databaseId: other.id, properties: { processingMethod: "pageContent", targetDatabase: "journal" } },
      userId,
      userId,
      { writerKind: "user" },
    );
    expect(item.properties).toMatchObject({ processingMethod: "pageContent", targetDatabase: "journal" });
  });
});
