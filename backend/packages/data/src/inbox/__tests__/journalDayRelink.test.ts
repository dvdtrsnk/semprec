import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import "../../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { ensureJournalPeriodDoc, getOrCreateJournalItem } from "../../journal/journalStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createApiCoreTaskList } from "../../worker.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let other: string;
let invalidations: InvalidationEvent[];
const recomputeTask = CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE;
const DAY = "2026-10-16";

async function databaseIds(tenantId: string): Promise<Record<string, string>> {
  const { rows } = await runInTenant(tenantId, () =>
    pool.query<{ id: string; owner_module_id: string }>("SELECT id, owner_module_id FROM databases"),
  );
  return Object.fromEntries(rows.map((row) => [row.owner_module_id, row.id]));
}

/** Captures one Inbox item through the production Inbox writer; its create hook links it to the day of `date`. */
function capture(tenantId: string, inboxId: string, date: string, text: string) {
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, date, time: "09:00", text }),
    ),
  );
}

/** The Journal day each Inbox item's `journalDay` edge points at. */
async function dayOf(tenantId: string, inboxId: string, itemIds: string[]): Promise<Record<string, string[]>> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
      const out: Record<string, string[]> = {};
      for (const id of itemIds) {
        const edges = await relationsStore.listRelationsForItem(client, definition!.id, id);
        out[id] = edges.map((edge) => relationsStore.otherSide(edge, id));
      }
      return out;
    }),
  );
}

/** Every relation edge of the tenant, every relation included, as stored. */
async function edgeSet(tenantId: string) {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{
      id: string;
      relation_definition_id: string;
      item_a: string;
      item_b: string;
      metadata: unknown;
    }>("SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations ORDER BY id");
    return rows;
  });
}

async function notificationCount(tenantId: string): Promise<number> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications");
    return rows[0]?.n ?? 0;
  });
}

/** Drains the queued Inbox recompute jobs with the production API task list. */
async function runRecomputeJobs(): Promise<void> {
  const handler = createApiCoreTaskList(pool, createActionRegistry())[recomputeTask];
  if (!handler) throw new Error("Journal Inbox recompute handler missing from production API task list");
  await runOnce({ pgPool: admin }, { [recomputeTask]: handler });
}

const inboxItemsSchema = z.array(z.object({ id: z.string() }));
async function computedInboxItemIds(tenantId: string, journalId: string, dayId: string): Promise<string[]> {
  const item = await runInTenant(tenantId, () => cp.getItem(journalId, dayId));
  return inboxItemsSchema
    .parse(item?.computed.inboxItems)
    .map((entry) => entry.id)
    .sort();
}

/**
 * A `journalDay` edge to an entry that is already in the trash. The relation writer refuses a trashed endpoint, and
 * the state only arises when an entry is trashed after its edges exist, so the test writes the row directly.
 */
async function insertEdgeToTrashedDay(tenantId: string, inboxId: string, inboxItemId: string, dayId: string) {
  await runInTenant(tenantId, async () => {
    const { property, definition } = await withTransaction(pool, async (client) => {
      const journalDay = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      return {
        property: journalDay!,
        definition: (await relationsStore.getRelationDefinitionByPropertyId(client, journalDay!.id))!,
      };
    });
    await pool.query(`DELETE FROM item_relations WHERE relation_definition_id = $1 AND (item_a = $2 OR item_b = $2)`, [
      definition.id,
      inboxItemId,
    ]);
    const [itemA, itemB] = definition.propertyIdA === property.id ? [inboxItemId, dayId] : [dayId, inboxItemId];
    await pool.query(
      "INSERT INTO item_relations (relation_definition_id, item_a, item_b, metadata) VALUES ($1, $2, $3, '{}'::jsonb)",
      [definition.id, itemA, itemB],
    );
  });
}

describe("re-linking a trashed day's Inbox items to its new Journal entry (issue #1603)", () => {
  let ids: Record<string, string>;

  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(pool));
    ids = await databaseIds(tenant);
    cp = createChokePoint(pool);
    invalidations = [];
    setInvalidationHook((event) => invalidations.push(event));
  });
  afterEach(() => {
    setInvalidationHook(() => {});
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  async function trashedDayWithSevenItems(): Promise<{ oldDay: string; items: string[] }> {
    const items: string[] = [];
    for (let n = 1; n <= 7; n++) items.push((await capture(tenant, ids.inbox!, DAY, `Note ${n}`)).id);
    const oldDay = (await dayOf(tenant, ids.inbox!, [items[0]!]))[items[0]!]![0]!;
    await runInTenant(tenant, () => cp.softDeleteItem(ids.journal!, oldDay));
    return { oldDay, items };
  }

  it("lists all seven Inbox items of a deleted day in the new entry created by the lazy create function", async () => {
    const { oldDay, items } = await trashedDayWithSevenItems();
    const elsewhere = await capture(tenant, ids.inbox!, "2026-10-15", "Other day");
    const otherDay = (await dayOf(tenant, ids.inbox!, [elsewhere.id]))[elsewhere.id]!;
    await runRecomputeJobs();

    const created = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY)),
    );
    expect(created.itemId).not.toBe(oldDay);
    const linked = await dayOf(tenant, ids.inbox!, [...items, elsewhere.id]);
    for (const id of items) expect(linked[id]).toEqual([created.itemId]);
    expect(linked[elsewhere.id]).toEqual(otherDay);
    expect(await countJobsByIdentifier(admin, recomputeTask)).toBe(2);

    await runRecomputeJobs();
    expect(await computedInboxItemIds(tenant, ids.journal!, created.itemId)).toEqual([...items].sort());
    const { rows } = await admin.query<{ computed: { inboxItems?: unknown } }>(
      "SELECT computed FROM items WHERE id = $1",
      [oldDay],
    );
    expect(rows[0]?.computed.inboxItems).toEqual([]);
  });

  it("re-links the same way when Inbox capture itself creates the new entry", async () => {
    const { items } = await trashedDayWithSevenItems();
    const latest = await capture(tenant, ids.inbox!, DAY, "After the delete");
    const newDay = (await dayOf(tenant, ids.inbox!, [latest.id]))[latest.id]![0]!;
    const linked = await dayOf(tenant, ids.inbox!, items);
    for (const id of items) expect(linked[id]).toEqual([newDay]);
    await runRecomputeJobs();
    expect(await computedInboxItemIds(tenant, ids.journal!, newDay)).toEqual([...items, latest.id].sort());
  });

  it("keeps a trashed Inbox item on the old entry", async () => {
    const { oldDay, items } = await trashedDayWithSevenItems();
    await runInTenant(tenant, () => cp.softDeleteItem(ids.inbox!, items[0]!));
    const created = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY)),
    );
    const linked = await dayOf(tenant, ids.inbox!, items);
    expect(linked[items[0]!]).toEqual([oldDay]);
    for (const id of items.slice(1)) expect(linked[id]).toEqual([created.itemId]);
  });

  it("writes no edge and queues nothing for a day with no trashed entry, or whose trashed entry has no Inbox items", async () => {
    const elsewhere = await capture(tenant, ids.inbox!, "2026-10-15", "Another day");
    const effects = async () => ({
      edges: await edgeSet(tenant),
      recomputeJobs: await countJobsByIdentifier(admin, recomputeTask),
      notifications: await notificationCount(tenant),
    });
    const before = await effects();
    expect(before.edges.some((edge) => edge.item_a === elsewhere.id || edge.item_b === elsewhere.id)).toBe(true);
    invalidations = [];
    await runInTenant(tenant, () => withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY)));
    expect(await effects()).toEqual(before);
    expect(invalidations.filter((event) => event.scope === "relation")).toEqual([]);

    const empty = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-17")),
    );
    await runInTenant(tenant, () => cp.softDeleteItem(ids.journal!, empty.itemId));
    const beforeEmpty = await effects();
    invalidations = [];
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", "2026-10-17")),
    );
    expect(await effects()).toEqual(beforeEmpty);
    expect(invalidations.filter((event) => event.scope === "relation")).toEqual([]);
  });

  it("does not re-run the re-link when the create is an idempotent replay", async () => {
    const { oldDay, items } = await trashedDayWithSevenItems();
    const created = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY)),
    );
    await insertEdgeToTrashedDay(tenant, ids.inbox!, items[0]!, oldDay);
    const linkedBefore = await dayOf(tenant, ids.inbox!, items);
    expect(Object.values(linkedBefore)).toEqual([[oldDay], ...items.slice(1).map(() => [created.itemId])]);
    const effects = async () => ({
      edges: await edgeSet(tenant),
      recomputeJobs: await countJobsByIdentifier(admin, recomputeTask),
      notifications: await notificationCount(tenant),
    });
    const before = await effects();
    invalidations = [];
    const replayed = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, ids.journal!, "day", new Date(`${DAY}T10:00:00Z`), "Europe/Prague"),
      ),
    );
    expect(replayed.id).toBe(created.itemId);
    expect(await dayOf(tenant, ids.inbox!, items)).toEqual(linkedBefore);
    expect(await effects()).toEqual(before);
    expect(invalidations.filter((event) => event.scope === "relation")).toEqual([]);
  });

  it("leaves entries that are not days alone", async () => {
    const week = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "week", "2026-W42")),
    );
    const item = await capture(tenant, ids.inbox!, DAY, "Note");
    await runInTenant(tenant, () => cp.softDeleteItem(ids.journal!, week.itemId));
    await insertEdgeToTrashedDay(tenant, ids.inbox!, item.id, week.itemId);
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "week", "2026-W42")),
    );
    expect((await dayOf(tenant, ids.inbox!, [item.id]))[item.id]).toEqual([week.itemId]);
  });

  it("re-links only the caller's tenant", async () => {
    const otherIds = await databaseIds(other);
    const foreignItem = await capture(other, otherIds.inbox!, DAY, "Foreign");
    const foreignDay = (await dayOf(other, otherIds.inbox!, [foreignItem.id]))[foreignItem.id]![0]!;
    await runInTenant(other, () => cp.softDeleteItem(otherIds.journal!, foreignDay));
    const { items } = await trashedDayWithSevenItems();
    const created = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY)),
    );
    for (const id of items) expect((await dayOf(tenant, ids.inbox!, [id]))[id]).toEqual([created.itemId]);
    expect((await dayOf(other, otherIds.inbox!, [foreignItem.id]))[foreignItem.id]).toEqual([foreignDay]);
  });

  it("fails the create and writes nothing when the Inbox journalDay relation is missing", async () => {
    const { oldDay } = await trashedDayWithSevenItems();
    // A broken schema no writer produces: the locked Inbox schema cannot lose a property through the public writer.
    await runInTenant(tenant, () =>
      pool.query("DELETE FROM properties WHERE database_id = $1 AND key = 'journalDay'", [ids.inbox]),
    );
    await expect(
      runInTenant(tenant, () => withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY))),
    ).rejects.toThrow("Inbox 'journalDay' relation not found");
    const { rows } = await runInTenant(tenant, () =>
      pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 AND properties->>'period' = $2 ORDER BY id",
        [ids.journal, DAY],
      ),
    );
    expect(rows.map((row) => row.id)).toEqual([oldDay]);
  });
});
