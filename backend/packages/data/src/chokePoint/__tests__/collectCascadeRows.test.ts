// Issue gh-1882: the rows a cascade reaches when the owning module registered a cascade expansion.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint.js";
import { registerItemCascadeExpansion } from "../hooks.js";
import * as itemsStore from "../itemsStore.js";
import { collectCascadeRows } from "../itemSubtreeAccess.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { ItemRow } from "../../types.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let eventsDatabaseId: string;
/** What the Events expansion registered below returns; each test sets it. */
let added: (root: ItemRow) => ItemRow[] = () => [];

function inTenant<T>(work: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, work);
}

async function row(databaseId: string, itemId: string): Promise<ItemRow> {
  const found = await inTenant(() =>
    withTransaction(pool, (client) => itemsStore.getItemById(client, databaseId, itemId)),
  );
  if (!found) throw new Error(`Item ${itemId} is missing`);
  return found;
}

async function event(name: string): Promise<ItemRow> {
  const created = await inTenant(() =>
    cp.createItem({ databaseId: eventsDatabaseId, properties: { name, date: "2026-10-16" } }),
  );
  return row(eventsDatabaseId, created.id);
}

/** A record in a new inline database of `owner`; returns the record. */
async function nestedRecord(owner: ItemRow): Promise<ItemRow> {
  return inTenant(async () => {
    const inline = await cp.createInlineDatabase({ name: `Inline of ${owner.id}`, parentItemId: owner.id });
    const created = await cp.createItem({ databaseId: inline.id, properties: {} });
    return row(inline.id, created.id);
  });
}

function cascade(root: ItemRow, include?: (candidate: ItemRow) => boolean): Promise<string[]> {
  return inTenant(() =>
    withTransaction(pool, async (client) => (await collectCascadeRows(client, root, include)).map((entry) => entry.id)),
  );
}

describe("collectCascadeRows (issue gh-1882)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
    // The Events module has no expansion in the composition point; this test gives it one it controls.
    registerItemCascadeExpansion(EVENTS_MODULE_ID, async ({ root }) => added(root));
  });
  beforeEach(async () => {
    added = () => [];
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool));
    const databases = await inTenant(() => cp.listDatabases());
    eventsDatabaseId = databases.find((database) => database.ownerModuleId === EVENTS_MODULE_ID)!.id;
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("gives the plain subtree of a root whose module's expansion adds nothing", async () => {
    const root = await event("Root");
    const nested = await nestedRecord(root);

    expect(await cascade(root)).toEqual([root.id, nested.id]);
  });

  it("gives the plain subtree of a root in a database without an owner module", async () => {
    const notes = await inTenant(() => cp.createDatabase({ name: "Notes" }));
    const note = await inTenant(() => cp.createItem({ databaseId: notes.id, properties: {} }));
    const root = await row(notes.id, note.id);
    const other = await event("Other");
    added = () => [other];
    const nested = await nestedRecord(root);

    expect(await cascade(root)).toEqual([root.id, nested.id]);
  });

  it("adds the rows of the expansion after the subtree, each with the rows of its own inline databases", async () => {
    const root = await event("Root");
    const nested = await nestedRecord(root);
    const first = await event("First");
    const second = await event("Second");
    const firstNested = await nestedRecord(first);
    added = () => [first, second];

    expect(await cascade(root)).toEqual([root.id, nested.id, first.id, firstNested.id, second.id]);
  });

  it("returns a row once when the expansion names the root, a row of its subtree or the same row twice", async () => {
    const root = await event("Root");
    const nested = await nestedRecord(root);
    const other = await event("Other");
    added = (candidate) => [candidate, nested, other, other];

    expect(await cascade(root)).toEqual([root.id, nested.id, other.id]);
  });

  it("leaves out a row of the expansion that `include` refuses, and the rows below it", async () => {
    const root = await event("Root");
    const nested = await nestedRecord(root);
    const kept = await event("Kept");
    const refused = await event("Refused");
    const refusedNested = await nestedRecord(refused);
    added = () => [kept, refused];
    const include = (candidate: ItemRow) => candidate.id !== refused.id;

    expect(await cascade(root, include)).toEqual([root.id, nested.id, kept.id]);
    expect(await cascade(root)).toContain(refusedNested.id);
  });
});
