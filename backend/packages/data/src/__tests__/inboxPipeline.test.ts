import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { listActiveInboxTypes } from "../inbox/inboxTypesStore.js";

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
    expect(typeProps.map((p) => p.key).sort()).toEqual(["emoji", "name", "status"]);
    expect(typeProps.find((p) => p.key === "status")).toMatchObject({ type: "select", owner: "user", config: { options: ["active", "archived"] } });

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
});
