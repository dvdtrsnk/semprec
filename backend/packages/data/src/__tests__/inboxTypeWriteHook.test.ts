import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  bindToTenantZero,
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
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
import { createUser } from "../auth/usersStore.js";
import { randomUUID } from "node:crypto";

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

/**
 * Takes the MCP servers database out of the tenant's module registry, the state of a tenant that does not have the
 * module. Direct SQL is the fixture: the seed always delivers the database and no write removes a system database.
 */
async function removeMcpServersDatabase(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'mcpServers' RETURNING id",
  );
  if (rows.length !== 1) throw new Error("Expected exactly one MCP servers database");
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

/** The eight hardcoded system databases a 'database' type may target: the ten system databases without journal and transcripts. mcpServers (issue #1973) has its own cases below. */
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

      it("accepts a 'database' type targeting mcpServers when the tenant has the MCP servers database", async () => {
        const type = await createType(source, { processingMethod: "database", targetDatabase: "mcpServers" });
        expect(type.properties).toMatchObject({ processingMethod: "database", targetDatabase: "mcpServers" });
      });

      it("refuses a 'database' type targeting mcpServers when the tenant has no MCP servers database and leaves no row", async () => {
        await removeMcpServersDatabase();

        await expect(
          createType(source, { processingMethod: "database", targetDatabase: "mcpServers" }),
        ).rejects.toMatchObject(refusalFor("targetDatabase"));
        expect(await countTypes()).toBe(0);
      });

      it("accepts a type that targets another database when the tenant has no MCP servers database", async () => {
        await removeMcpServersDatabase();

        const type = await createType(source, { processingMethod: "database", targetDatabase: "tasks" });
        expect(type.properties).toMatchObject({ processingMethod: "database", targetDatabase: "tasks" });
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

      it("accepts a patch that switches the target to mcpServers when the tenant has the MCP servers database", async () => {
        const updated = await patchType(source, itemId, { targetDatabase: "mcpServers" });
        expect(updated.properties).toMatchObject({ processingMethod: "database", targetDatabase: "mcpServers" });
      });

      it("refuses a patch that switches the target to mcpServers when the tenant has no MCP servers database and keeps the stored pair", async () => {
        await removeMcpServersDatabase();

        await expect(patchType(source, itemId, { targetDatabase: "mcpServers" })).rejects.toMatchObject(
          refusalFor("targetDatabase"),
        );
        const stored = await chokePoint.getItem(typesId, itemId);
        expect(stored?.properties).toMatchObject({ processingMethod: "database", targetDatabase: "tasks" });
      });

      it("accepts a rename of a type stored with mcpServers after the tenant lost the MCP servers database", async () => {
        await patchType(source, itemId, { targetDatabase: "mcpServers" });
        await removeMcpServersDatabase();

        const renamed = await patchType(source, itemId, { name: "Renamed" });
        expect(renamed.properties).toMatchObject({ name: "Renamed", targetDatabase: "mcpServers" });
      });

      it("refuses a write that sets the stored mcpServers pair again after the tenant lost the MCP servers database", async () => {
        await patchType(source, itemId, { targetDatabase: "mcpServers" });
        await removeMcpServersDatabase();

        await expect(
          patchType(source, itemId, { processingMethod: "database", targetDatabase: "mcpServers" }),
        ).rejects.toMatchObject(refusalFor("targetDatabase"));
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

  it("looks the MCP servers database up in the writing tenant only, through the runtime role (issue #1973)", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const withMcp = getTenantZeroId();
      const withoutMcp = await createTestTenant(pool);
      const viewTypeRegistry = createViewTypeRegistry();
      await runInTenant(withoutMcp, () => seedSystem(runtime, viewTypeRegistry));
      // Direct SQL is the fixture: the seed always delivers the database and no write removes a system database.
      const removed = await pool.query(
        "UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'mcpServers' AND tenant_id = $1",
        [withoutMcp],
      );
      expect(removed.rowCount).toBe(1);
      const userInWithoutMcp = await createUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: "unused",
        tenantId: withoutMcp,
      });
      const runtimeChokePoint = createChokePoint(runtime, createComputedKeyRegistry(), viewTypeRegistry);
      const typesIn = (tenantId: string): Promise<string> =>
        runInTenant(tenantId, async () => {
          const { rows } = await runtime.query<{ id: string }>(
            "SELECT id FROM databases WHERE owner_module_id = 'inboxItemTypes'",
          );
          if (!rows[0]) throw new Error("Inbox item types database was not seeded");
          return rows[0].id;
        });
      const createMcpType = (tenantId: string, actingUserId: string) =>
        runInTenant(tenantId, async () =>
          runtimeChokePoint.createItem(
            {
              databaseId: await typesIn(tenantId),
              properties: { name: "Type", emoji: "🧪", processingMethod: "database", targetDatabase: "mcpServers" },
            },
            actingUserId,
            actingUserId,
            { writerKind: "user" },
          ),
        );

      const accepted = await createMcpType(withMcp, userId);
      expect(accepted.properties).toMatchObject({ targetDatabase: "mcpServers" });
      await expect(createMcpType(withoutMcp, userInWithoutMcp.id)).rejects.toMatchObject(refusalFor("targetDatabase"));
    } finally {
      await runtime.end();
    }
  });
});
