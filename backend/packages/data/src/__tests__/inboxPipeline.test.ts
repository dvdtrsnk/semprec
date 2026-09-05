import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { ValidationError } from "../errors.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient, deleteInboxTypeWithClient, listActiveInboxTypes, updateInboxTypeWithClient } from "../inbox/inboxTypesStore.js";

let pool: Pool;
let chokePoint: ChokePoint;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("Inbox pipeline databases (issue #101)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("seeds inbox/inboxItemTypes/processingProposals as system, schema-locked databases with the exact schema", async () => {
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const proposalsId = await databaseIdFor("processingProposals");

    for (const databaseId of [inboxId, typesId, proposalsId]) {
      const { rows } = await pool.query("SELECT system, schema_locked FROM databases WHERE id = $1", [databaseId]);
      expect(rows[0]).toEqual({ system: true, schema_locked: true });

      const { rows: viewRows } = await pool.query("SELECT type, created_by, is_default FROM views WHERE database_id = $1", [databaseId]);
      expect(viewRows).toHaveLength(1);
      expect(viewRows[0]).toMatchObject({ type: "table", created_by: "system", is_default: true });
    }

    const inboxProps = await chokePoint.listProperties(inboxId);
    expect(inboxProps.map((p) => p.key).sort()).toEqual(["date", "journalDay", "text", "time", "type"]);
    expect(inboxProps.find((p) => p.key === "date")).toMatchObject({ type: "date", owner: "user" });
    expect(inboxProps.find((p) => p.key === "time")).toMatchObject({ type: "time", owner: "user" });
    expect(inboxProps.find((p) => p.key === "text")).toMatchObject({ type: "text", owner: "user" });
    expect(inboxProps.find((p) => p.key === "type")).toMatchObject({ type: "relation", owner: "user" });
    expect(inboxProps.find((p) => p.key === "journalDay")).toMatchObject({ type: "relation", owner: "system" });

    const typeProps = await chokePoint.listProperties(typesId);
    expect(typeProps.map((p) => p.key).sort()).toEqual(["emoji", "name", "processingMethod", "status", "targetDatabase"]);
    expect(typeProps.find((p) => p.key === "status")).toMatchObject({ type: "select", owner: "user", config: { options: ["active", "archived"] } });
    expect(typeProps.find((p) => p.key === "processingMethod")).toMatchObject({
      type: "select",
      owner: "user",
      config: { options: ["pageContent", "database"] },
    });
    expect(typeProps.find((p) => p.key === "targetDatabase")).toMatchObject({ type: "select", owner: "user" });
    expect((typeProps.find((p) => p.key === "targetDatabase")!.config as { options: string[] }).options).toEqual(
      expect.arrayContaining(["tasks", "events", "projects"]),
    );

    const proposalProps = await chokePoint.listProperties(proposalsId);
    expect(proposalProps.map((p) => p.key).sort()).toEqual([
      "fingerprint",
      "history",
      "kind",
      "proposal",
      "resultItemId",
      "resultLabel",
      "sourceInbox",
      "sourceTranscript",
      "status",
    ]);
    expect(proposalProps.find((p) => p.key === "kind")).toMatchObject({ type: "select", owner: "system", config: { options: ["inbox", "transcript"] } });
    expect(proposalProps.find((p) => p.key === "proposal")).toMatchObject({ type: "json", owner: "system" });
    expect(proposalProps.find((p) => p.key === "history")).toMatchObject({ type: "json", owner: "system" });
    expect(proposalProps.find((p) => p.key === "sourceInbox")).toMatchObject({ type: "relation", owner: "system" });
    expect(proposalProps.find((p) => p.key === "sourceTranscript")).toMatchObject({ type: "relation", owner: "system" });
    expect(proposalProps.find((p) => p.key === "status")).toMatchObject({
      type: "select",
      owner: "system",
      config: { options: ["needsClarification", "proposed", "confirmed", "rejected", "invalid"] },
    });
  });

  it("re-running the seed is idempotent — no duplicate databases/properties", async () => {
    await seedSystem(pool, viewTypeRegistry); // second run, same process's registry
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM databases WHERE owner_module_id = $1", ["inbox"]);
    expect(rows[0].n).toBe(1);
  });

  it("rejects an Inbox item missing date or time", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");

    await expect(
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "", time: "14:30" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("preserves client-supplied date/time verbatim and resolves journalDay lazily, once", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");

    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "23:45",
        text: "Buy milk",
      }),
    );
    expect(item.properties).toMatchObject({ date: "2026-08-28", time: "23:45", text: "Buy milk" });

    const edges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, item.id));
    expect(edges).toHaveLength(1);
    const journalDayItemId = [edges[0].itemA, edges[0].itemB].find((id) => id !== item.id)!;

    const { rows } = await pool.query("SELECT properties FROM items WHERE id = $1", [journalDayItemId]);
    expect(rows[0].properties).toMatchObject({ type: "day", period: "2026-08-28" });

    // A second Inbox item on the same day reuses the same Journal day item (lazy, idempotent).
    const secondItem = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "08:00" }),
    );
    const secondEdges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, secondItem.id));
    const secondJournalDayItemId = [secondEdges[0].itemA, secondEdges[0].itemB].find((id) => id !== secondItem.id)!;
    expect(secondJournalDayItemId).toBe(journalDayItemId);

    const { rows: journalRows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [journalId]);
    expect(journalRows[0].n).toBe(1);
  });

  it("an Inbox item without a type can still be created", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");

    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "09:00" }),
    );
    expect(item.properties.type).toBeUndefined();
  });

  it("links an Inbox item to a real type by id, and renaming the type's emoji does not break the relation", async () => {
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const journalId = await databaseIdFor("journal");

    const type = await chokePoint.createItem({ databaseId: typesId, properties: { name: "Task", emoji: "☑️", status: "active" } });
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        type: type.id,
      }),
    );

    await chokePoint.updateItem({ databaseId: typesId, itemId: type.id, propertiesPatch: { emoji: "🆕" } });

    const edges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, type.id));
    const linkedInboxItemId = edges.map((e) => [e.itemA, e.itemB]).flat().find((id) => id === item.id);
    expect(linkedInboxItemId).toBe(item.id);
  });

  it("GET /api/inbox-types equivalent: lists only active types as { id, emoji, label }, never by emoji", async () => {
    const typesId = await databaseIdFor("inboxItemTypes");
    const active = await chokePoint.createItem({ databaseId: typesId, properties: { name: "Task", emoji: "☑️", status: "active" } });
    await chokePoint.createItem({ databaseId: typesId, properties: { name: "Old", emoji: "🗑️", status: "archived" } });

    const types = await withTransaction(pool, (client) => listActiveInboxTypes(client, typesId));
    expect(types).toEqual([{ id: active.id, emoji: "☑️", label: "Task" }]);
  });

  it("accepts 'database' with a valid targetDatabase, and 'pageContent' with none", async () => {
    const typesId = await databaseIdFor("inboxItemTypes");

    const task = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    expect(task.properties).toMatchObject({ processingMethod: "database", targetDatabase: "tasks" });

    const thought = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Thought", emoji: "💭", processingMethod: "pageContent" }),
    );
    expect(thought.properties.processingMethod).toBe("pageContent");
    expect(thought.properties.targetDatabase).toBeUndefined();
  });

  it("rejects 'database' without a targetDatabase, and 'pageContent' with one", async () => {
    const typesId = await databaseIdFor("inboxItemTypes");

    await expect(
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Thought",
          emoji: "💭",
          processingMethod: "pageContent",
          targetDatabase: "tasks",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown processingMethod or targetDatabase value", async () => {
    const typesId = await databaseIdFor("inboxItemTypes");

    await expect(
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          // @ts-expect-error — intentionally invalid for the test
          processingMethod: "notARealMethod",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          // @ts-expect-error — intentionally invalid for the test
          targetDatabase: "inboxItemTypes",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("update: judges the patch against the resulting whole, not the patch in isolation", async () => {
    const typesId = await databaseIdFor("inboxItemTypes");
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );

    // Patching targetDatabase alone is valid: the existing processingMethod is already 'database'.
    const updated = await withTransaction(pool, (client) =>
      updateInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, itemId: type.id, propertiesPatch: { targetDatabase: "events" } }),
    );
    expect(updated.properties.targetDatabase).toBe("events");

    // Switching to 'pageContent' without explicitly clearing targetDatabase is rejected.
    await expect(
      withTransaction(pool, (client) =>
        updateInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, itemId: type.id, propertiesPatch: { processingMethod: "pageContent" } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Explicitly clearing targetDatabase alongside the switch succeeds.
    const switched = await withTransaction(pool, (client) =>
      updateInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        itemId: type.id,
        propertiesPatch: { processingMethod: "pageContent", targetDatabase: null },
      }),
    );
    expect(switched.properties.processingMethod).toBe("pageContent");
    expect(switched.properties.targetDatabase).toBeNull();
  });

  it("deleting a referenced type dereferences unlocked Inbox items but leaves locked ones untouched", async () => {
    const inboxId = await databaseIdFor("inbox");
    const typesId = await databaseIdFor("inboxItemTypes");
    const proposalsId = await databaseIdFor("processingProposals");
    const journalId = await databaseIdFor("journal");

    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );

    const unlockedItem = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "09:00", type: type.id }),
    );
    const lockedItem = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "10:00", type: type.id }),
    );

    // A confirmed Processing proposal card locks its source Inbox item. `kind`/`status` are
    // owner:'system' (written only by the not-yet-implemented confirm flow, issue #105), so
    // this test seeds the row directly, the same way a real confirm would.
    const proposal = await withTransaction(pool, (client) =>
      itemsStore.insertItem(client, {
        databaseId: proposalsId,
        properties: { kind: "inbox", fingerprint: "x", proposal: {}, history: [], status: "confirmed" },
      }),
    );
    const sourceInboxProperty = await chokePoint.listProperties(proposalsId).then((props) => props.find((p) => p.key === "sourceInbox")!);
    await chokePoint.createRelation({ relationPropertyId: sourceInboxProperty.id, itemId: proposal.id, targetItemId: lockedItem.id });

    await withTransaction(pool, (client) =>
      deleteInboxTypeWithClient(client, { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId, typeItemId: type.id }),
    );

    const { rows: typeRow } = await pool.query("SELECT deleted_at FROM items WHERE id = $1", [type.id]);
    expect(typeRow[0].deleted_at).not.toBeNull();

    const unlockedEdges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, unlockedItem.id));
    expect(unlockedEdges.some((e) => e.itemA === type.id || e.itemB === type.id)).toBe(false);

    const lockedEdges = await withTransaction(pool, (client) => relationsStore.listAllRelationsForItem(client, lockedItem.id));
    expect(lockedEdges.some((e) => e.itemA === type.id || e.itemB === type.id)).toBe(true);
  });
});
