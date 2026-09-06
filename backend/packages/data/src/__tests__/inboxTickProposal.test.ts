import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inbox/inboxTickAction.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function sha256Of(emoji: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ emoji, text })).digest("hex");
}

describe("semprec.tick fingerprinting and proposal create/revise/skip (issue #223)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function findProposalForItem(itemId: string) {
    return withTransaction(pool, async (client) => {
      const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty!.id);
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
      if (edges.length === 0) return null;
      const proposalItemId = relationsStore.otherSide(edges[0], itemId);
      return itemsStore.getItemById(client, proposalsId, proposalItemId);
    });
  }

  async function runTick(itemId: string, computeProposal: ComputeSemprecProposalFn): Promise<void> {
    const handler = createSemprecTickAction(pool, computeProposal);
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId },
    );
  }

  it("creates exactly one proposed row with the generic envelope and correct fingerprint for a 'database' type", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );

    let calls = 0;
    await runTick(item.id, async (input) => {
      calls++;
      expect(input.entityKind).toBe("database");
      expect(input.targetDatabaseId).toBeTruthy();
      return { properties: { name: "Buy milk" } };
    });
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("proposed");
    expect(proposal!.properties.fingerprint).toBe(sha256Of("☑️", "Buy milk"));
    expect(proposal!.properties.history).toEqual([]);

    const tasksDbId = await databaseIdFor("tasks");
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksDbId,
      properties: { name: "Buy milk" },
    });
    expect(Object.keys(proposal!.properties.proposal as object).sort()).toEqual(["entityKind", "properties", "target"]);
  });

  it("uses the injected function's target for a 'pageContent' type", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Thought", emoji: "💭", processingMethod: "pageContent" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(item.id, async (input) => {
      expect(input.entityKind).toBe("pageContent");
      expect(input.targetDatabaseId).toBeUndefined();
      return { target: "some-page-id", properties: { content: "A thought" } };
    });

    const proposal = await findProposalForItem(item.id);
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: "some-page-id",
      properties: { content: "A thought" },
    });
  });

  it("an unchanged fingerprint makes no AI call and no proposal write", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );

    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = await findProposalForItem(item.id);

    await runTick(item.id, async () => {
      throw new Error("computeProposal must not be called for an unchanged fingerprint");
    });
    const second = await findProposalForItem(item.id);
    expect(second!.updatedAt).toBe(first!.updatedAt);
  });

  it("an edit that changes the fingerprint revises the same row rather than creating a second one", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = await findProposalForItem(item.id);

    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy milk and eggs" } }),
    );

    await runTick(item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));
    const revised = await findProposalForItem(item.id);

    expect(revised!.id).toBe(first!.id);
    expect(revised!.properties.fingerprint).toBe(sha256Of("☑️", "Buy milk and eggs"));
    expect(revised!.properties.proposal).toEqual({ entityKind: "database", target: await databaseIdFor("tasks"), properties: { name: "Buy milk and eggs" } });
    expect(revised!.properties.history).toEqual([]);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(1);
  });

  it("a confirmed or rejected proposal is never modified by a later tick, even when the source changes", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposal = await findProposalForItem(item.id);

    await withTransaction(pool, (client) => itemsStore.updateItemProperties(client, { databaseId: proposalsId, itemId: proposal!.id, propertiesPatch: { status: "confirmed" } }));
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Something totally different" } }),
    );

    await runTick(item.id, async () => {
      throw new Error("computeProposal must not be called for a locked proposal");
    });

    const stillLocked = await findProposalForItem(item.id);
    expect(stillLocked!.properties.status).toBe("confirmed");
    expect(stillLocked!.properties.fingerprint).toBe(sha256Of("☑️", "Buy milk"));
  });

  it("a soft-deleted existing proposal is treated as absent — a later tick creates a fresh one instead of throwing", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    const original = await findProposalForItem(item.id);
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, original!.id));

    // The relation edge to the now-deleted proposal is still there, so this must not throw
    // NotFoundError from trying to update a deleted item — it must fall through and create.
    await runTick(item.id, async () => ({ properties: { name: "Buy milk (retry)" } }));

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(2);

    const stillDeleted = await itemsStore.getItemById(pool, proposalsId, original!.id);
    expect(stillDeleted!.deletedAt).not.toBeNull();

    // Now two `sourceInbox` edges exist for this item: one to the soft-deleted original, one
    // to the live replacement. A further tick must find the live one regardless of which edge
    // comes back first from the relation lookup — reviving it rather than creating a third row.
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy milk and eggs" } }),
    );
    await runTick(item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));

    const { rows: afterThirdTick } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(afterThirdTick[0].n).toBe(2);

    const { rows: liveRows } = await pool.query(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].properties.fingerprint).toBe(sha256Of("☑️", "Buy milk and eggs"));
  });

  it("an item with no type creates no proposal (stub for issue #104)", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "09:00", text: "no type" }),
    );

    await runTick(item.id, async () => {
      throw new Error("computeProposal must not be called for an untyped item");
    });

    expect(await findProposalForItem(item.id)).toBeNull();
  });

  it("never writes a row into any database other than processingProposals", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, { inboxItemTypesDatabaseId: typesId, name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );

    const tasksDbId = await databaseIdFor("tasks");
    const { rows: before } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksDbId]);

    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));

    const { rows: after } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksDbId]);
    expect(after[0].n).toBe(before[0].n);
  });
});
