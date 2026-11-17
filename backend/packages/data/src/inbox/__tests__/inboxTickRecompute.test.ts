import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { bindToTenantZero, getTestPool, inTenantZero, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { createComputedKeyRegistry } from "../../chokePoint/computedKeyRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createCoreTaskList } from "../../worker.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { withTransaction } from "../../db/pool.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createInboxTypeWithClient } from "../inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";
import { confirmProposalWithClient } from "../proposalActions.js";
import {
  JOURNAL_INBOX_COMPUTED_KEY,
  journalInboxRecomputeJobKey,
  type JournalInboxItemSummary,
} from "../journalInboxCompute.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function pendingRecomputeJobKeys(): Promise<string[]> {
  const { rows } = await pool.query<{ key: string }>(
    `SELECT j.key
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'journalInboxRecompute'`,
  );
  return rows.map((r) => r.key).sort();
}

/** Removes every pending recompute job, so only an enqueue made after this call is observed. */
async function clearRecomputeJobs(): Promise<void> {
  await pool.query(
    `DELETE FROM graphile_worker._private_jobs
     WHERE task_id IN (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'journalInboxRecompute')`,
  );
}

describe("Inbox tick write phase recomputes the day's Inbox summary (issue #1390)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    const computedKeyRegistry = createComputedKeyRegistry();
    chokePoint = bindToTenantZero(createChokePoint(pool, computedKeyRegistry, viewTypeRegistry));
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry, computedKeyRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function runTick(itemId: string, computeProposal: ComputeSemprecProposalFn): Promise<void> {
    const handler = createSemprecTickAction(pool, computeProposal);
    await inTenantZero(() =>
      handler(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId },
      ),
    );
  }

  async function createTaskType() {
    return inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      ),
    );
  }

  async function captureItem(text: string, typeId?: string) {
    return inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text,
          type: typeId,
        }),
      ),
    );
  }

  async function journalDayIdFor(itemId: string): Promise<string> {
    return inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty!.id);
        const edges = await relationsStore.listRelationsForItem(client, definition!.id, itemId);
        return relationsStore.otherSide(edges[0]!, itemId);
      }),
    );
  }

  async function cachedStatus(dayId: string): Promise<string | null | undefined> {
    const day = await chokePoint.getItem(journalId, dayId);
    const items = day?.computed[JOURNAL_INBOX_COMPUTED_KEY] as JournalInboxItemSummary[] | undefined;
    return items?.[0]?.status;
  }

  async function drainQueue(): Promise<void> {
    await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) });
  }

  /**
   * Runs a tick whose compute step clears the recompute jobs the read phase and capture enqueued,
   * then runs `inCompute`, so a job present afterwards was enqueued by the write phase.
   */
  async function tickWithClearedJobs(itemId: string, inCompute: () => Promise<void> = async () => {}) {
    const dayId = await journalDayIdFor(itemId);
    await clearRecomputeJobs();
    await runTick(itemId, async () => {
      // This job exists before the write phase starts; clear it to observe only later enqueues.
      expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayId)]);
      await clearRecomputeJobs();
      await inCompute();
      return { properties: { name: "Buy milk" } };
    });
  }

  it("enqueues the day's recompute when the tick creates a proposal, and the job sets the status", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);

    await tickWithClearedJobs(item.id);

    expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayId)]);
    await drainQueue();
    expect(await cachedStatus(dayId)).toBe("proposed");
  });

  it("enqueues the day's recompute when the tick revises a proposal", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = (await chokePoint.listItems(proposalsId)).items;
    expect(first).toHaveLength(1);
    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy oat milk" } });

    await tickWithClearedJobs(item.id);

    const revised = (await chokePoint.listItems(proposalsId)).items;
    expect(revised).toHaveLength(1);
    expect(revised[0]?.id).toBe(first[0]?.id);
    expect(revised[0]?.properties.fingerprint).not.toBe(first[0]?.properties.fingerprint);
    expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayId)]);
    await drainQueue();
    expect(await cachedStatus(dayId)).toBe("proposed");
  });

  it("refreshes edited source text for a locked card without a card write", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    const cards = (await chokePoint.listItems(proposalsId)).items;
    if (cards.length !== 1 || !cards[0]) throw new Error("Expected one proposal");
    const confirmed = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cards[0]!.id),
      ),
    );
    await drainQueue();
    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy oat milk" } });
    await clearRecomputeJobs();
    await runTick(item.id, async () => {
      throw new Error("Locked card must not be recomputed");
    });
    expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayId)]);
    const after = await chokePoint.getItem(proposalsId, confirmed.id);
    expect(after?.properties).toEqual(confirmed.properties);
    expect(after?.updatedAt).toBe(confirmed.updatedAt);
    await drainQueue();
    const day = await chokePoint.getItem(journalId, dayId);
    const items = day?.computed[JOURNAL_INBOX_COMPUTED_KEY];
    expect(items).toMatchObject([{ id: item.id, text: "Buy oat milk", status: "confirmed" }]);
  });

  it("enqueues the day's recompute when the tick creates a needs-clarification proposal", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);

    // A target database that is not a valid destination fails envelope validation.
    await runTick(item.id, async () => {
      await clearRecomputeJobs();
      return { properties: { unknownProperty: "x" } };
    });

    expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayId)]);
    await drainQueue();
    expect(await cachedStatus(dayId)).toBe("needsClarification");
  });

  it("enqueues the day's recompute when the tick revises a proposal into needs-clarification", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);
    const dayId = await journalDayIdFor(item.id);
    await runTick(item.id, async () => ({ properties: { name: "Buy milk" } }));
    await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy oat milk" } });

    await runTick(item.id, async () => {
      await clearRecomputeJobs();
      return { properties: { unknownProperty: "x" } };
    });

    expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayId)]);
    await drainQueue();
    expect(await cachedStatus(dayId)).toBe("needsClarification");
  });

  it("enqueues nothing when the item changed while the tick computed", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);

    await tickWithClearedJobs(item.id, async () => {
      await chokePoint.updateItem({ databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Changed" } });
      await clearRecomputeJobs();
    });

    expect(await pendingRecomputeJobKeys()).toEqual([]);
    expect((await chokePoint.listItems(proposalsId)).items).toHaveLength(0);
  });

  it("enqueues nothing when the item was deleted while the tick computed", async () => {
    const type = await createTaskType();
    const item = await captureItem("Buy milk", type.id);

    await tickWithClearedJobs(item.id, async () => {
      await chokePoint.softDeleteItem(inboxId, item.id);
      await clearRecomputeJobs();
    });

    expect(await pendingRecomputeJobKeys()).toEqual([]);
    expect((await chokePoint.listItems(proposalsId)).items).toHaveLength(0);
  });
});
