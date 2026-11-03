import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { writeBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import "../../domainWriteHooks.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "../../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { mutateDoc } from "../../docs/docPersistence.js";
import { getOrCreateDoc } from "../../docs/docsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { handleItemSearchPageTextTask } from "../../search/pageTextJob.js";
import { createApiCoreTaskList } from "../../worker.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { getOrCreateJournalItem } from "../journalStore.js";
import { JOURNAL_SUMMARY_COMPUTED_KEY, recomputeJournalSummary } from "../journalSummary.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let computedKeyRegistry: ComputedKeyRegistry;
let tenant: string;
let events: InvalidationEvent[];
const taskName = CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT;

/*
 * Tenant scope is entered per helper and never around `runOnce`: the queue drain is a system scope, and the
 * production task list enters each job's own tenant from its envelope.
 */
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function databaseIdOf(key: string): Promise<string> {
  return inTenant(() =>
    withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, key);
      if (!database) throw new Error(`Missing fixture database: ${key}`);
      return database.id;
    }),
  );
}

/** A quarter entry, created through the production Journal path (no page yet). */
async function newQuarterEntry(journalId: string): Promise<string> {
  return inTenant(() =>
    withTransaction(pool, async (client) => {
      const entry = await getOrCreateJournalItem(client, journalId, "quarter", new Date("2026-10-01T12:00:00Z"), "UTC");
      return entry.id;
    }),
  );
}

/**
 * Appends blocks to an item's page through the block writer and a production doc update, as the editor does. The shared
 * page fixture takes text blocks only, and these tests need a heading as well.
 */
async function writePageBlocks(itemId: string, blocks: { type: "h2" | "text"; text: string }[]): Promise<void> {
  await inTenant(async () => {
    const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, itemId, "page"));
    await mutateDoc(pool, doc.id, "user", (ydoc) => {
      for (const block of blocks) writeBlock(ydoc, { id: randomUUID(), type: block.type, text: block.text });
    });
  });
}

/** The entry's `computed` value through the choke point's read, or undefined when the item is missing or not readable. */
async function summaryOf(databaseId: string, itemId: string): Promise<unknown> {
  const item = await inTenant(() => cp.getItem(databaseId, itemId));
  return item?.computed[JOURNAL_SUMMARY_COMPUTED_KEY];
}

/** The stored `computed` object, read with the admin pool so a soft-deleted item is still visible to the assertion. */
async function storedComputed(itemId: string): Promise<Record<string, unknown>> {
  const { rows } = await admin.query<{ computed: Record<string, unknown> }>(
    "SELECT computed FROM items WHERE id = $1",
    [itemId],
  );
  if (!rows[0]) throw new Error(`Missing item fixture: ${itemId}`);
  return rows[0].computed;
}

function itemEvents(itemId: string): InvalidationEvent[] {
  return events.filter((event) => event.scope === "item" && event.itemId === itemId);
}

/** Drains the queue once with the production API task list. */
async function runPageTextJobs(): Promise<void> {
  const taskList = createApiCoreTaskList(pool, createActionRegistry());
  const handler = taskList[taskName];
  if (!handler) throw new Error("Page-text handler missing from production API task list");
  await runOnce({ pgPool: admin }, { [taskName]: handler });
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  computedKeyRegistry = createComputedKeyRegistry();
  cp = createChokePoint(pool, computedKeyRegistry);
  await inTenant(() => seedSystem(pool, createViewTypeRegistry(), computedKeyRegistry));
  events = [];
  setInvalidationHook((event) => events.push(event));
  // Edits are written 60 seconds in the past, so their 30-second debounce has elapsed when the queue is drained.
  // Only `Date` is faked; the database clock and Graphile Worker's polling are untouched.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 60_000);
});
afterEach(() => {
  vi.useRealTimers();
  setInvalidationHook(() => {});
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("Journal summary (issue #1711)", () => {
  it("does not write a foreign tenant's summary and processes the owner's queued edit", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [{ type: "h2", text: "Owner heading" }]);
    const foreign = await createTestTenant(admin);
    await runInTenant(foreign, () => seedSystem(pool, createViewTypeRegistry()));
    events = [];
    await runInTenant(foreign, () => handleItemSearchPageTextTask(pool, { itemId: entry }));
    expect(await summaryOf(journalId, entry)).toBeUndefined();
    expect(itemEvents(entry)).toEqual([]);
    await runPageTextJobs();
    expect(await summaryOf(journalId, entry)).toBe("Owner heading");
    expect(itemEvents(entry)).toHaveLength(1);
  });

  it("stores the heading that starts a quarter page as the summary within one trigger run", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [{ type: "h2", text: "Cíle kvartálu" }]);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(1);
    await runPageTextJobs();
    expect(await summaryOf(journalId, entry)).toBe("Cíle kvartálu");
  });

  it("stores the first line of a page that has only paragraphs", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [
      { type: "text", text: "Odstavec o plánu" },
      { type: "text", text: "Další věta" },
    ]);
    await runPageTextJobs();
    expect(await summaryOf(journalId, entry)).toBe("Odstavec o plánu");
  });

  it("stores a first line of 120 characters cut to 80 characters", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [{ type: "text", text: "a".repeat(120) }]);
    await runPageTextJobs();
    expect(await summaryOf(journalId, entry)).toBe("a".repeat(80));
  });

  it("stores null for an entry that has no page", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await inTenant(() => handleItemSearchPageTextTask(pool, { itemId: entry }));
    expect(await storedComputed(entry)).toEqual({ [JOURNAL_SUMMARY_COMPUTED_KEY]: null });
  });

  it("stores null for an entry whose page exists but holds no text", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await inTenant(() => withTransaction(pool, (client) => getOrCreateDoc(client, entry, "page")));
    await inTenant(() => handleItemSearchPageTextTask(pool, { itemId: entry }));
    expect(await storedComputed(entry)).toEqual({ [JOURNAL_SUMMARY_COMPUTED_KEY]: null });
  });

  it("refuses a property with the journalSummary key on the Journal database", async () => {
    const journalId = await databaseIdOf("journal");
    await expect(
      inTenant(() =>
        cp.createProperty({
          databaseId: journalId,
          key: JOURNAL_SUMMARY_COMPUTED_KEY,
          name: "Souhrn",
          type: "text",
          owner: "user",
        }),
      ),
    ).rejects.toThrow(/collides with a declared module cache key/);
    expect(await inTenant(() => cp.getPropertyByKey(journalId, JOURNAL_SUMMARY_COMPUTED_KEY))).toBeNull();
  });

  it("accepts a property whose key only resembles the reserved one, on a user database", async () => {
    const database = await inTenant(() => cp.createDatabaseWithProperties({ name: "Pokusná databáze" }, "Název", []));
    const property = await inTenant(() =>
      cp.createProperty({
        databaseId: database.id,
        key: "journalSummaryDraft",
        name: "Koncept",
        type: "text",
        owner: "user",
      }),
    );
    expect(property.key).toBe("journalSummaryDraft");
  });

  it("announces the summary when it is first stored", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [{ type: "h2", text: "Cíle kvartálu" }]);
    events = [];
    await runPageTextJobs();
    expect(itemEvents(entry)).toEqual([
      { scope: "item", databaseId: journalId, itemId: entry, op: "update", updatedAt: expect.any(String) },
    ]);
  });

  it("announces nothing when a later edit leaves the first line unchanged", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [{ type: "h2", text: "Cíle kvartálu" }]);
    await runPageTextJobs();
    events = [];
    await writePageBlocks(entry, [{ type: "text", text: "Nový odstavec pod nadpisem" }]);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(1);
    await runPageTextJobs();
    expect(itemEvents(entry)).toEqual([]);
    expect(await summaryOf(journalId, entry)).toBe("Cíle kvartálu");
  });

  it("leaves a soft-deleted entry's summary unwritten when its job runs", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await writePageBlocks(entry, [{ type: "h2", text: "Smazaný záznam" }]);
    await inTenant(() => cp.softDeleteItem(journalId, entry));
    await runPageTextJobs();
    expect(Object.hasOwn(await storedComputed(entry), JOURNAL_SUMMARY_COMPUTED_KEY)).toBe(false);
  });

  it("leaves a soft-deleted entry unwritten when its summary is recomputed directly", async () => {
    const journalId = await databaseIdOf("journal");
    const entry = await newQuarterEntry(journalId);
    await inTenant(() => cp.softDeleteItem(journalId, entry));
    await inTenant(() =>
      withTransaction(pool, (client) => recomputeJournalSummary(client, journalId, entry, "Nový text")),
    );
    expect(Object.hasOwn(await storedComputed(entry), JOURNAL_SUMMARY_COMPUTED_KEY)).toBe(false);
  });

  it("does nothing when the entry being recomputed does not exist", async () => {
    const journalId = await databaseIdOf("journal");
    const missing = randomUUID();
    await inTenant(() =>
      withTransaction(pool, (client) => recomputeJournalSummary(client, journalId, missing, "Nový text")),
    );
    expect(itemEvents(missing)).toEqual([]);
  });

  it("writes no summary for a non-Journal item that has a page", async () => {
    const tasksId = await databaseIdOf("tasks");
    const task = await inTenant(() => cp.createItem({ databaseId: tasksId, properties: { name: "Úkol" } }));
    await writePageBlocks(task.id, [{ type: "h2", text: "Nadpis úkolu" }]);
    await runPageTextJobs();
    expect(Object.hasOwn(await storedComputed(task.id), JOURNAL_SUMMARY_COMPUTED_KEY)).toBe(false);
  });

  it("writes no summary for a non-Journal item that has no page", async () => {
    const tasksId = await databaseIdOf("tasks");
    const task = await inTenant(() => cp.createItem({ databaseId: tasksId, properties: { name: "Úkol bez stránky" } }));
    await inTenant(() => handleItemSearchPageTextTask(pool, { itemId: task.id }));
    expect(Object.hasOwn(await storedComputed(task.id), JOURNAL_SUMMARY_COMPUTED_KEY)).toBe(false);
  });
});
