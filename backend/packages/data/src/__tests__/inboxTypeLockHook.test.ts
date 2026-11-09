import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { listRelationsForItem, getRelationDefinitionByPropertyId, otherSide } from "../chokePoint/relationsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;

describe("Inbox type lock", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function fixture(status?: string, trash = false) {
    const cp = createChokePoint(pool);
    const ids = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["inbox", "inboxItemTypes", "processingProposals"]],
    );
    const id = (key: string) => {
      const row = ids.rows.find((entry) => entry.owner_module_id === key);
      if (!row) throw new Error("Missing seeded database");
      return row.id;
    };
    const inbox = id("inbox"),
      types = id("inboxItemTypes"),
      proposals = id("processingProposals");
    const makeType = (name: string) =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: types,
          name,
          emoji: "x",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
    const first = await makeType("First");
    const second = await makeType("Second");
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inbox, date: "2026-10-01", time: "10:00", type: first.id }),
    );
    const type = (await cp.listProperties(inbox)).find((p) => p.key === "type");
    const source = (await cp.listProperties(proposals)).find((p) => p.key === "sourceInbox");
    if (!type || !source) throw new Error("Missing seeded relation");
    if (status) {
      // Synthetic historical card: the public API cannot create a card directly in a decided state.
      const card = await withTransaction(pool, (client) =>
        insertItem(client, {
          databaseId: proposals,
          properties: { kind: "inbox", fingerprint: "test", proposal: {}, history: [], status },
        }),
      );
      await withTransaction(pool, (client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: source.id, callerItemId: card.id, targetItemId: item.id },
          { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID },
        ),
      );
      if (trash) await withTransaction(pool, (client) => softDeleteItem(client, proposals, card.id));
    }
    const edge = { relationPropertyId: type.id, callerItemId: item.id, targetItemId: first.id };
    const targets = () =>
      withTransaction(pool, async (client) => {
        const definition = await getRelationDefinitionByPropertyId(client, type.id);
        if (!definition) throw new Error("Missing type definition");
        return (await listRelationsForItem(client, definition.id, item.id)).map((relation) =>
          otherSide(relation, item.id),
        );
      });
    return { cp, edge, second: second.id, targets };
  }

  it("refuses a second type without changing the first edge", async () => {
    const { cp, edge, second, targets } = await fixture();
    await expect(cp.createRelation({ ...edge, targetItemId: second })).rejects.toMatchObject({
      status: 409,
      code: "cardinality_violation",
    });
    expect(await targets()).toEqual([edge.targetItemId]);
  });

  it.each(["confirmed", "rejected"])("preserves the edge for a %s card", async (status) => {
    const { cp, edge, second, targets } = await fixture(status);
    await expect(cp.deleteRelation(edge)).rejects.toMatchObject({ status: 409, code: "proposal_locked" });
    await expect(cp.createRelation({ ...edge, targetItemId: second })).rejects.toMatchObject({
      status: 409,
      code: "proposal_locked",
    });
    expect(await targets()).toEqual([edge.targetItemId]);
  });

  it.each([
    [undefined, false],
    ["proposed", false],
    ["confirmed", true],
  ] as const)("allows a type change for status %s trashed=%s", async (status, trash) => {
    const { cp, edge, second, targets } = await fixture(status, trash);
    expect(await cp.deleteRelation(edge)).not.toBeNull();
    expect((await cp.createRelation({ ...edge, targetItemId: second })).itemB).toBe(second);
    expect(await targets()).toEqual([second]);
  });
});
