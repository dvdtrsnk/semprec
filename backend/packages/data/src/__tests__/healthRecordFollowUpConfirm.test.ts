import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import {
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  type ProposalComputationResult,
  type ProposalEnvelope,
} from "../inbox/inboxTickAction.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { confirmProposalWithClient } from "../inbox/proposalActions.js";
import { seedSystem } from "../seed/seedSystem.js";
import type { ItemRow } from "../types.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

interface Fixture {
  inbox: string;
  types: string;
  proposals: string;
  tasks: string;
  healthRecords: string;
  areas: string;
  /** Property ids of `Tasks.healthRecords`, `HealthRecords.tasks` and `HealthRecords.area`. */
  tasksHealthRecords: string;
  recordsTasks: string;
  recordsArea: string;
  /** The relation definition `Tasks.healthRecords` and `HealthRecords.tasks` share. */
  followUpDefinition: string;
}

/** The ids of the tenant's databases and relation properties this test reads, resolved as that tenant. */
async function loadFixture(tenantId: string): Promise<Fixture> {
  return runInTenant(tenantId, () =>
    withTransaction(runtime, async (client) => {
      const database = async (moduleId: string): Promise<string> => {
        const row = await getDatabaseByModuleId(client, moduleId);
        if (!row) throw new Error(`Database '${moduleId}' was not seeded`);
        return row.id;
      };
      const property = async (databaseId: string, key: string): Promise<string> => {
        const row = await propertiesStore.getPropertyByKey(client, databaseId, key);
        if (!row) throw new Error(`Property '${key}' was not seeded`);
        return row.id;
      };
      const tasks = await database("tasks");
      const healthRecords = await database("healthRecords");
      const tasksHealthRecords = await property(tasks, "healthRecords");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, tasksHealthRecords);
      if (!definition) throw new Error("Tasks.healthRecords has no relation definition");
      return {
        inbox: await database("inbox"),
        types: await database("inboxItemTypes"),
        proposals: await database("processingProposals"),
        tasks,
        healthRecords,
        areas: await database("areas"),
        tasksHealthRecords,
        recordsTasks: await property(healthRecords, "tasks"),
        recordsArea: await property(healthRecords, "area"),
        followUpDefinition: definition.id,
      };
    }),
  );
}

const RECORD = { name: "Blood pressure 150/95", tags: ["bloodPressure"] };
const FOLLOW_UP = { name: "Check-up at the doctor", date: "2026-10-30" };

/** What the computation answers for a health note with a follow-up check: the record, and a task linked to it. */
const RECORD_WITH_FOLLOW_UP: ProposalComputationResult = {
  properties: RECORD,
  operations: [
    { op: "create", database: "healthRecords", alias: "record", properties: RECORD },
    {
      op: "create",
      database: "tasks",
      alias: "followUp",
      properties: FOLLOW_UP,
      relations: { healthRecords: [{ alias: "record" }] },
    },
  ],
};

describe("a health record and its follow-up task on confirm (issue #1836)", () => {
  let ids: Fixture;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
    other = await createTestTenant(admin);
    for (const tenantId of [tenant, other]) {
      await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
    }
    ids = await loadFixture(tenant);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /**
   * A proposal card for a health note through the production path: an active Inbox type that targets Health
   * records, an Inbox item of that type and one tick whose computation answers `result`, so the card holds the
   * envelope exactly as the tick validated and stored it.
   */
  async function createHealthCard(result: ProposalComputationResult): Promise<ItemRow> {
    return runInTenant(tenant, async () => {
      const type = await withTransaction(runtime, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: ids.types,
          name: "Health note",
          emoji: "🩺",
          processingMethod: "database",
          targetDatabase: "healthRecords",
        }),
      );
      const item = await withTransaction(runtime, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: ids.inbox,
          date: "2026-10-16",
          time: "09:00",
          text: "Blood pressure 150/95, check-up at the doctor on 30 October",
          type: type.id,
        }),
      );
      await createSemprecTickAction(runtime, async () => result)(
        {
          inboxDatabaseId: ids.inbox,
          inboxItemTypesDatabaseId: ids.types,
          processingProposalsDatabaseId: ids.proposals,
        },
        { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
      );
      return withTransaction(runtime, async (client) => {
        const sourceInbox = await propertiesStore.getPropertyByKey(client, ids.proposals, "sourceInbox");
        if (!sourceInbox) throw new Error("The proposals database has no sourceInbox property");
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox.id);
        if (!definition) throw new Error("The sourceInbox property has no relation definition");
        const [edge] = await relationsStore.listRelationsForItem(client, definition.id, item.id);
        if (!edge) throw new Error("The tick stored no proposal card");
        const card = await itemsStore.getItemById(client, ids.proposals, relationsStore.otherSide(edge, item.id));
        if (!card) throw new Error("The proposal card is missing");
        return card;
      });
    });
  }

  function storedEnvelope(card: ItemRow): ProposalEnvelope {
    const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
    if (!envelope || "unknownKind" in envelope) throw new Error("The card holds no computed envelope");
    return envelope;
  }

  /**
   * Turns the card's follow-up step off. Before issue #1920 no production write sets a step's `enabled` flag, so
   * the envelope is rewritten through the system-owned `proposal` write the tick itself uses.
   */
  async function disableFollowUp(card: ItemRow): Promise<void> {
    const envelope = storedEnvelope(card);
    if (!envelope.operations) throw new Error("The card holds no steps");
    const operations = envelope.operations.map((step) =>
      step.ref === "followUp" ? { ...step, enabled: false } : step,
    );
    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: ids.proposals,
            itemId: card.id,
            propertiesPatch: { proposal: { ...envelope, operations } },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      ),
    );
  }

  function confirmWithClient(client: PoolClient, cardId: string): Promise<ItemRow> {
    return confirmProposalWithClient(client, { processingProposalsDatabaseId: ids.proposals }, cardId);
  }

  function confirm(cardId: string): Promise<ItemRow> {
    return runInTenant(tenant, () => withTransaction(runtime, (client) => confirmWithClient(client, cardId)));
  }

  function resultItemId(confirmed: ItemRow): string {
    const id = confirmed.properties.resultItemId;
    if (typeof id !== "string") throw new Error("The confirmed card names no result item");
    return id;
  }

  /** The live items of one of the tenant's databases, read on a pooled connection of its own. */
  async function itemsOf(tenantId: string, databaseId: string): Promise<ItemRow[]> {
    const page = await runInTenant(tenantId, () => createChokePoint(runtime).queryDatabaseItems(databaseId, {}));
    return page.items;
  }

  /** The ids an item is linked to through one of its relation properties. */
  async function linkedThrough(itemId: string, relationPropertyId: string): Promise<string[]> {
    const entries = await runInTenant(tenant, () =>
      createChokePoint(runtime).listItemRelations(itemId, relationPropertyId),
    );
    if (!entries) throw new Error("Item missing");
    return entries.map((entry) => entry.targetItemId);
  }

  /**
   * The committed state, read on pooled connections of its own and so never on a transaction the caller holds open:
   * the number of health records, tasks and follow-up edges, and the card status.
   */
  async function committedState(
    cardId: string,
  ): Promise<{ records: number; tasks: number; edges: number; status: unknown }> {
    const records = await itemsOf(tenant, ids.healthRecords);
    const tasks = await itemsOf(tenant, ids.tasks);
    return runInTenant(tenant, async () => {
      const edges = await runtime.query<{ id: string }>(
        "SELECT id FROM item_relations WHERE relation_definition_id = $1",
        [ids.followUpDefinition],
      );
      const card = await withTransaction(runtime, (client) => itemsStore.getItemById(client, ids.proposals, cardId));
      return {
        records: records.length,
        tasks: tasks.length,
        edges: edges.rows.length,
        status: card?.properties.status,
      };
    });
  }

  it("creates the record and the task dated 30 October, linked through the new relation, and no area edge", async () => {
    const card = await createHealthCard(RECORD_WITH_FOLLOW_UP);
    expect(card.properties.status).toBe("proposed");
    expect(storedEnvelope(card).operations).toEqual([
      { ref: "record", op: "create", role: "primary", databaseKey: "healthRecords", properties: RECORD },
      {
        ref: "followUp",
        op: "create",
        role: "secondary",
        databaseKey: "tasks",
        properties: FOLLOW_UP,
        relations: { healthRecords: [{ ref: "record" }] },
      },
    ]);

    const confirmed = await confirm(card.id);

    expect(confirmed.properties).toMatchObject({ status: "confirmed", resultLabel: RECORD.name });
    const records = await itemsOf(tenant, ids.healthRecords);
    const tasks = await itemsOf(tenant, ids.tasks);
    expect(records.map((record) => record.id)).toEqual([resultItemId(confirmed)]);
    expect(records[0]?.properties).toMatchObject(RECORD);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.properties).toMatchObject(FOLLOW_UP);
    const recordId = resultItemId(confirmed);
    const taskId = tasks[0]?.id;
    if (!taskId) throw new Error("Follow-up task missing");
    expect(await linkedThrough(recordId, ids.recordsTasks)).toEqual([taskId]);
    expect(await linkedThrough(taskId, ids.tasksHealthRecords)).toEqual([recordId]);
    expect(await linkedThrough(recordId, ids.recordsArea)).toEqual([]);

    // The other tenant received nothing.
    const foreign = await loadFixture(other);
    expect(await itemsOf(other, foreign.healthRecords)).toEqual([]);
    expect(await itemsOf(other, foreign.tasks)).toEqual([]);
  });

  it("writes the record, the task, the edge and the card status in one transaction", async () => {
    const card = await createHealthCard(RECORD_WITH_FOLLOW_UP);
    const untouched = { records: 0, tasks: 0, edges: 0, status: "proposed" };
    const failure = new Error("roll the confirmation back");

    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const confirmed = await confirmWithClient(client, card.id);
          // The confirming transaction sees all four writes ...
          expect(confirmed.properties.status).toBe("confirmed");
          const created = await client.query<{ database_id: string }>(
            "SELECT database_id FROM items WHERE database_id = ANY($1::uuid[]) ORDER BY database_id",
            [[ids.healthRecords, ids.tasks]],
          );
          expect(created.rows.map((row) => row.database_id)).toEqual([ids.healthRecords, ids.tasks].sort());
          const edges = await client.query<{ id: string }>(
            "SELECT id FROM item_relations WHERE relation_definition_id = $1",
            [ids.followUpDefinition],
          );
          expect(edges.rows).toHaveLength(1);
          // ... and before it commits, another connection of the same tenant sees none of them.
          expect(await committedState(card.id)).toEqual(untouched);
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(await committedState(card.id)).toEqual(untouched);

    await confirm(card.id);
    expect(await committedState(card.id)).toEqual({ records: 1, tasks: 1, edges: 1, status: "confirmed" });
  });

  it("creates only the record when the follow-up task step is disabled", async () => {
    const card = await createHealthCard(RECORD_WITH_FOLLOW_UP);
    await disableFollowUp(card);

    const confirmed = await confirm(card.id);

    expect(await committedState(card.id)).toEqual({ records: 1, tasks: 0, edges: 0, status: "confirmed" });
    const recordId = resultItemId(confirmed);
    expect((await itemsOf(tenant, ids.healthRecords)).map((record) => record.id)).toEqual([recordId]);
    expect(await linkedThrough(recordId, ids.recordsTasks)).toEqual([]);
    expect(await linkedThrough(recordId, ids.recordsArea)).toEqual([]);
  });

  it("still confirms a single-item health record envelope: no task, and no area edge until the user sets one", async () => {
    const card = await createHealthCard({ properties: RECORD });
    expect(storedEnvelope(card)).toEqual({ entityKind: "database", target: ids.healthRecords, properties: RECORD });

    const confirmed = await confirm(card.id);

    expect(confirmed.properties).toMatchObject({ status: "confirmed", resultLabel: RECORD.name });
    expect(await committedState(card.id)).toEqual({ records: 1, tasks: 0, edges: 0, status: "confirmed" });
    const recordId = resultItemId(confirmed);
    const records = await itemsOf(tenant, ids.healthRecords);
    expect(records.map((record) => record.id)).toEqual([recordId]);
    expect(records[0]?.properties).toMatchObject(RECORD);
    expect(await linkedThrough(recordId, ids.recordsArea)).toEqual([]);

    // The same read lists an area once the user links one, so the empty answers above are not a blind read.
    const chokePoint = createChokePoint(runtime);
    const area = await runInTenant(tenant, async () => {
      const created = await chokePoint.createItem({ databaseId: ids.areas, properties: { name: "Health" } });
      await chokePoint.createRelation({
        relationPropertyId: ids.recordsArea,
        callerItemId: recordId,
        targetItemId: created.id,
      });
      return created.id;
    });
    expect(await linkedThrough(recordId, ids.recordsArea)).toEqual([area]);
  });
});
