import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { writeBlock, type TextRun } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import "../../domainWriteHooks.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { mutateDoc } from "../../docs/docPersistence.js";
import { getOrCreateDoc } from "../../docs/docsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createApiCoreTaskList } from "../../worker.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { getOrCreateJournalItem } from "../journalStore.js";
import { syncJournalEventLinks } from "../journalEventLinks.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let other: string;
let databases: Record<string, string>;
let invalidations: InvalidationEvent[];
const taskName = CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant, fn);
const link = (id: string, text = "Standup"): TextRun => ({
  insert: text,
  attributes: { link: { href: `semprec://items/${id}` } },
});

async function databaseIds(tenantId: string): Promise<Record<string, string>> {
  const { rows } = await runInTenant(tenantId, () =>
    pool.query<{ id: string; owner_module_id: string }>("SELECT id, owner_module_id FROM databases"),
  );
  return Object.fromEntries(rows.map((row) => [row.owner_module_id, row.id]));
}

async function newDay(): Promise<string> {
  return inTenant(() =>
    withTransaction(pool, async (client) => {
      const day = await getOrCreateJournalItem(
        client,
        databases.journal!,
        "day",
        new Date("2026-10-16T10:00:00Z"),
        "Europe/Prague",
      );
      return day.id;
    }),
  );
}

/** Writes (or rewrites, by id) one text block of the day's page through the block writer and a production doc update. */
async function writeLine(itemId: string, blockId: string, text: string | TextRun[]): Promise<void> {
  await inTenant(async () => {
    const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, itemId, "page"));
    await mutateDoc(pool, doc.id, "user", (ydoc) => writeBlock(ydoc, { id: blockId, type: "text", text }));
  });
}

/** Drains the queue once with the production API task list, as the worker runs the after-document-update job. */
async function runPageTextJobs(): Promise<void> {
  const handler = createApiCoreTaskList(pool, createActionRegistry())[taskName];
  if (!handler) throw new Error("Page-text handler missing from production API task list");
  await runOnce({ pgPool: admin }, { [taskName]: handler });
}

/** The day's `events` edges with their row ids, so a delete-and-recreate of an unchanged edge would show. */
async function eventEdges(dayId: string): Promise<Array<{ id: string; target: string }>> {
  return inTenant(() =>
    withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, databases.journal!, "events");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
      const edges = await relationsStore.listRelationsForItem(client, definition!.id, dayId);
      return edges
        .map((edge) => ({ id: edge.id, target: relationsStore.otherSide(edge, dayId) }))
        .sort((a, b) => a.target.localeCompare(b.target));
    }),
  );
}

const relationEvents = () => invalidations.filter((event) => event.scope === "relation");

describe("Journal events relation follows the page's event links (issue #2016)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(pool));
    databases = await databaseIds(tenant);
    cp = createChokePoint(pool);
    invalidations = [];
    setInvalidationHook((event) => invalidations.push(event));
    // Edits are written 60 seconds in the past, so their 30-second debounce has elapsed when the queue is drained.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 60_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    setInvalidationHook(() => {});
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  const event = (name: string) =>
    inTenant(() => cp.createItem({ databaseId: databases.events!, properties: { name } }));

  it("adds the edge when a link to an event is added and removes it when the link is removed", async () => {
    const day = await newDay();
    const standup = await event("Standup");
    const block = randomUUID();
    await writeLine(day, block, [{ insert: "Notes from the " }, link(standup.id)]);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(1);
    await runPageTextJobs();
    expect((await eventEdges(day)).map((edge) => edge.target)).toEqual([standup.id]);

    await writeLine(day, block, "Notes from the Standup");
    await runPageTextJobs();
    expect(await eventEdges(day)).toEqual([]);
  });

  it("gives two links to the same event one edge and creates none for a link to a task", async () => {
    const day = await newDay();
    const standup = await event("Standup");
    const task = await inTenant(() =>
      cp.createItem({ databaseId: databases.tasks!, properties: { name: "Follow up" } }),
    );
    await writeLine(day, randomUUID(), [link(standup.id), { insert: " and again " }, link(standup.id.toUpperCase())]);
    await writeLine(day, randomUUID(), [link(task.id, "Follow up")]);
    await runPageTextJobs();
    expect((await eventEdges(day)).map((edge) => edge.target)).toEqual([standup.id]);
  });

  it("writes and announces nothing when the page changes without changing its event links", async () => {
    const day = await newDay();
    const standup = await event("Standup");
    await writeLine(day, randomUUID(), [link(standup.id)]);
    await runPageTextJobs();
    const before = await eventEdges(day);
    expect(before.map((edge) => edge.target)).toEqual([standup.id]);
    invalidations = [];
    await writeLine(day, randomUUID(), "Another paragraph");
    await runPageTextJobs();
    expect(await eventEdges(day)).toEqual(before);
    expect(relationEvents()).toEqual([]);
  });

  it("drops the edge of an event that is moved to the trash on the next sync", async () => {
    const day = await newDay();
    const standup = await event("Standup");
    await writeLine(day, randomUUID(), [link(standup.id)]);
    await runPageTextJobs();
    expect((await eventEdges(day)).map((edge) => edge.target)).toEqual([standup.id]);
    await inTenant(() => cp.softDeleteItem(databases.events!, standup.id));
    await writeLine(day, randomUUID(), "Later edit");
    await runPageTextJobs();
    expect(await eventEdges(day)).toEqual([]);
  });

  it("never links another tenant's event", async () => {
    const day = await newDay();
    const otherDatabases = await databaseIds(other);
    const foreign = await runInTenant(other, () =>
      cp.createItem({ databaseId: otherDatabases.events!, properties: { name: "Foreign" } }),
    );
    const own = await event("Standup");
    await writeLine(day, randomUUID(), [link(foreign.id), { insert: " / " }, link(own.id)]);
    await runPageTextJobs();
    expect((await eventEdges(day)).map((edge) => edge.target)).toEqual([own.id]);
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM item_relations WHERE item_a = $1 OR item_b = $1",
      [foreign.id],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("still refuses a user write of the relation through the generic relation endpoint", async () => {
    const day = await newDay();
    const standup = await event("Standup");
    const property = await inTenant(async () =>
      (await cp.listProperties(databases.journal!)).find((p) => p.key === "events"),
    );
    await expect(
      inTenant(() =>
        cp.createRelation({ relationPropertyId: property!.id, callerItemId: day, targetItemId: standup.id }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    expect(await eventEdges(day)).toEqual([]);
  });

  it("leaves a trashed entry unchanged and refuses a tenant whose Journal has no events relation", async () => {
    const day = await newDay();
    const standup = await event("Standup");
    await inTenant(() => cp.softDeleteItem(databases.journal!, day));
    await inTenant(() =>
      withTransaction(pool, (client) => syncJournalEventLinks(client, day, `[Standup](semprec://items/${standup.id})`)),
    );
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM item_relations WHERE item_a = $1",
      [day],
    );
    expect(rows[0]?.n).toBe(0);

    const live = await newDay();
    // A tenant whose locked Journal schema predates issue #1609; the public writer cannot remove the property.
    await inTenant(() =>
      pool.query("DELETE FROM properties WHERE database_id = $1 AND key = 'events'", [databases.journal]),
    );
    await expect(
      inTenant(() => withTransaction(pool, (client) => syncJournalEventLinks(client, live, ""))),
    ).rejects.toThrow("Journal has no 'events' relation");
  });
});
