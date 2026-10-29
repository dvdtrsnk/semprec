import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import { getSystemTimezone } from "../systemSettings.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, ValidationError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import {
  appendHistoryEntry,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  type ComputeSemprecProposalFn,
  type ProposalEnvelope,
} from "../inbox/inboxTickAction.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reviseProposalWithClient,
} from "../inbox/proposalActions.js";
import { deleteItemDependents } from "../chokePoint/itemTrash.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let docStore: DocStore;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("Processing proposal confirm/reject/revise (issue #105)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let tasksId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    tasksId = await databaseIdFor("tasks");
  });

  async function findProposalForItem(itemId: string) {
    return withTransaction(pool, async (client) => {
      const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(
        client,
        sourceInboxProperty!.id,
      );
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
      if (edges.length === 0) return null;
      const proposalItemId = relationsStore.otherSide(edges[0]!, itemId);
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

  async function createDatabaseProposal(text = "Buy milk") {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    await runTick(item.id, async () => ({ properties: { name: text } }));
    return (await findProposalForItem(item.id))!;
  }

  async function createPageContentProposal(text = "A thought") {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    // The Inbox item type itself stands in for a "page" target here — confirm only needs an existing item id.
    await runTick(item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: text } },
    }));
    return { proposal: (await findProposalForItem(item.id))!, targetPageId: type.id };
  }

  it("confirm on a 'database' proposal creates the target item, locks confirmed, and records resultItemId/resultLabel", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    expect(typeof confirmed.properties.resultItemId).toBe("string");
    expect(confirmed.properties.resultLabel).toBe("Buy milk");
    const history = confirmed.properties.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ author: "user" });

    const createdTask = await withTransaction(pool, (client) =>
      itemsStore.getItemById(client, tasksId, confirmed.properties.resultItemId as string),
    );
    expect(createdTask).toBeTruthy();
    expect(createdTask!.properties.name).toBe("Buy milk");
  });

  it("confirm is idempotent under retry: a second confirm does not create a second target item", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const first = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const second = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
    expect(second.updatedAt).toBe(first.updatedAt);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(1);
  });

  it("confirm on a 'pageContent' proposal appends the block and locks confirmed", async () => {
    const { proposal, targetPageId } = await createPageContentProposal("A thought");

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    expect(confirmed.properties.resultItemId).toBe(targetPageId);

    const block = await docStore.getBlock(targetPageId, proposal.id);
    expect(block).toMatchObject({ "sys:flavour": "paragraph", content: "A thought" });
  });

  it("confirm refuses a needsClarification proposal (no computed envelope)", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(item.id, async () => {
      throw new Error("must not be called");
    });
    const proposal = (await findProposalForItem(item.id))!;

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/Cannot confirm a proposal in status 'needsClarification'/);
  });

  it("confirm refuses an already-rejected proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/Cannot confirm a proposal in status 'rejected'/);
  });

  async function setStoredProperty(proposalId: string, key: string, value: unknown): Promise<void> {
    await pool.query(`UPDATE items SET properties = jsonb_set(properties, $2::text[], $3::jsonb) WHERE id = $1`, [
      proposalId,
      `{${key}}`,
      JSON.stringify(value),
    ]);
  }

  it("confirm rejects a stored envelope that is not { entityKind, target, properties }", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await setStoredProperty(proposal.id, "proposal", { entityKind: "database" });

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(`Malformed proposal envelope on proposal ${proposal.id}`);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(0);
  });

  describe("unknown stored entityKind", () => {
    const futureEnvelope = { entityKind: "someFutureKind", target: "future-target", properties: { a: 1 } };

    async function createFutureKindProposal() {
      const proposal = await createDatabaseProposal("Buy milk");
      await setStoredProperty(proposal.id, "proposal", futureEnvelope);
      return proposal;
    }

    async function readCard(proposalId: string) {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposalId));
    }

    it("lists and reads the card with the stored envelope untouched", async () => {
      const proposal = await createFutureKindProposal();

      const card = await readCard(proposal.id);
      expect(card!.properties.proposal).toEqual(futureEnvelope);
      expect(card!.properties.status).toBe("proposed");
      expect(parseStoredProposalEnvelope(card!.properties.proposal, proposal.id)).toEqual({
        unknownKind: true,
        ...futureEnvelope,
      });
    });

    it("confirm answers 409 naming the kind, leaves the card proposed and writes nothing", async () => {
      const proposal = await createFutureKindProposal();

      const error = await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).status).toBe(409);
      expect((error as ConflictError).message).toContain("someFutureKind");

      const card = await readCard(proposal.id);
      expect(card!.properties.status).toBe("proposed");
      expect(card!.properties.proposal).toEqual(futureEnvelope);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
      expect(rows[0].n).toBe(0);
    });

    it("revise answers 409 and leaves the stored envelope unchanged", async () => {
      const proposal = await createFutureKindProposal();

      const error = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "fix it",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy bread" },
        }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).status).toBe(409);
      expect((error as ConflictError).message).toContain("someFutureKind");

      const card = await readCard(proposal.id);
      expect(card!.properties.proposal).toEqual(futureEnvelope);
      expect(card!.properties.status).toBe("proposed");
    });

    it("revise still rejects writing an unknown entityKind as before", async () => {
      const proposal = await createDatabaseProposal("Buy milk");

      await expect(
        withTransaction(pool, (client) =>
          reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
            message: "x",
            entityKind: "someFutureKind" as never,
            target: tasksId,
            properties: {},
          }),
        ),
      ).rejects.toThrow(/unknown entityKind 'someFutureKind'/);
    });

    it("a structurally malformed envelope still throws on read", () => {
      expect(() => parseStoredProposalEnvelope({ entityKind: "someFutureKind", target: "t" }, "p1")).toThrow(
        "Malformed proposal envelope on proposal p1",
      );
      expect(() => parseStoredProposalEnvelope({ entityKind: 5, target: "t", properties: {} }, "p1")).toThrow(
        "Malformed proposal envelope",
      );
    });
  });

  it("confirm still reports a null stored envelope as having no computed envelope", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await setStoredProperty(proposal.id, "proposal", null);

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow("Proposal has no computed envelope to confirm");
  });

  it("appendHistoryEntry treats a history holding a malformed entry as empty", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await setStoredProperty(proposal.id, "history", [
      { author: "ai", message: "Created a proposal for the source item.", at: "2026-08-28T09:00:00.000Z" },
      { author: "robot", message: 42 },
    ]);
    const stored = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));

    const history = appendHistoryEntry(stored!.properties.history, "Not needed", "user");

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ author: "user", message: "Not needed" });
  });

  it("appendHistoryEntry keeps legacy entries byte-identical and adds no kind without extra", () => {
    const legacy = { author: "user", message: "Old", at: "2026-08-28T09:00:00.000Z" };

    const history = appendHistoryEntry([legacy], "New");

    expect(JSON.stringify(history[0])).toBe(JSON.stringify(legacy));
    expect(Object.keys(history[1]!).sort()).toEqual(["at", "author", "message"]);
  });

  it("appendHistoryEntry keeps a userEdit entry with keys across further appends", () => {
    let history = appendHistoryEntry([], "Edited title", "user", { kind: "userEdit", keys: ["primary.title"] });
    const first = JSON.stringify(history[0]);
    history = appendHistoryEntry(history, "Second");
    history = appendHistoryEntry(history, "Third", "user");

    expect(history).toHaveLength(3);
    expect(JSON.stringify(history[0])).toBe(first);
    expect(history[0]).toMatchObject({ kind: "userEdit", keys: ["primary.title"], author: "user" });
  });

  it("appendHistoryEntry keeps threadRevision thread and message ids", () => {
    let history = appendHistoryEntry([], "Revised", "ai", { kind: "threadRevision", threadId: "t1", messageId: "m1" });
    history = appendHistoryEntry(history, "Later");

    expect(history[0]).toMatchObject({ kind: "threadRevision", threadId: "t1", messageId: "m1" });
  });

  it("reject locks rejected and writes no target", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const rejected = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, "Not needed"),
    );

    expect(rejected.properties.status).toBe("rejected");
    expect(rejected.properties.resultItemId).toBeUndefined();
    const history = rejected.properties.history as Array<Record<string, unknown>>;
    expect(history[1]).toMatchObject({ author: "user", message: "Not needed" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(rows[0].n).toBe(0);
  });

  it("reject is idempotent under retry", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    const first = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );
    const second = await withTransaction(pool, (client) =>
      rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("reject refuses an already-confirmed proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      ),
    ).rejects.toThrow(/already been confirmed/);
  });

  it("revise can switch a proposal from 'database' to 'pageContent' atomically and records the message", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const pageTarget = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );

    const revised = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
        message: "Actually this is a note",
        entityKind: "pageContent",
        target: pageTarget.id,
        properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
      }),
    );

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: pageTarget.id,
      properties: { flavour: "paragraph", fields: { content: "Buy milk" } },
    });
    const history = revised.properties.history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Actually this is a note" });
  });

  it("revise stores a valid relations map and refuses a deleted target without touching the card (issue #1426)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    const projectsId = await databaseIdFor("projects");
    const project = await withTransaction(
      pool,
      async (client) =>
        (await createItemWithClient(client, { databaseId: projectsId, properties: { name: "Home" } })).id,
    );
    const revise = (relations: Record<string, string[]>) =>
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "link it",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
          relations,
        }),
      );

    const revised = await revise({ project: [project] });
    expect(revised.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
      relations: { project: [project] },
    });

    await withTransaction(pool, async (client) => {
      await itemsStore.softDeleteItem(client, projectsId, project);
    });
    const error = await revise({ project: [project] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toEqual({ field: "project", code: "targetDeleted" });
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
    expect(card!.properties.proposal).toEqual(revised.properties.proposal);
  });

  describe("relations on confirm (issue #1476)", () => {
    async function proposalWithRelations(relations: Record<string, string[]>) {
      const proposal = await createDatabaseProposal("Buy milk");
      await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "link it",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
          relations,
        }),
      );
      return proposal;
    }
    async function createProject(name: string): Promise<string> {
      const projectsId = await databaseIdFor("projects");
      return withTransaction(
        pool,
        async (client) => (await createItemWithClient(client, { databaseId: projectsId, properties: { name } })).id,
      );
    }
    const confirm = (proposalId: string) =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      );
    const countTasks = async () =>
      (await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId])).rows[0].n as number;
    const countEdges = async () =>
      (await pool.query("SELECT count(*)::int AS n FROM item_relations")).rows[0].n as number;

    it("writes the task and its project edge in one transaction, once even when confirmed again", async () => {
      const project = await createProject("Home");
      const proposal = await proposalWithRelations({ project: [project] });
      const before = await countEdges();

      const confirmed = await confirm(proposal.id);
      expect(await countTasks()).toBe(1);
      expect(await countEdges()).toBe(before + 1);
      const { rows } = await pool.query(
        "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
        [confirmed.properties.resultItemId, project],
      );
      expect(rows).toHaveLength(1);

      await confirm(proposal.id);
      expect(await countEdges()).toBe(before + 1);
    });

    it("rolls back item and edge with field 'project' when a target disappears before confirm", async () => {
      const project = await createProject("Home");
      const proposal = await proposalWithRelations({ project: [project] });
      const projectsId = await databaseIdFor("projects");
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, projectsId, project));
      const before = await countEdges();

      const error = await confirm(proposal.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: "project" });
      expect(await countTasks()).toBe(0);
      expect(await countEdges()).toBe(before);
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
      expect(card!.properties.status).toBe("proposed");
    });

    it("rolls back the item and the first edge when the second edge violates cardinality", async () => {
      const first = await createProject("Home");
      const second = await createProject("Work");
      const proposal = await proposalWithRelations({ project: [first, second] });
      const before = await countEdges();

      const error = await confirm(proposal.id).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 409, details: { field: "project" } });
      expect(await countTasks()).toBe(0);
      expect(await countEdges()).toBe(before);
      const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
      expect(card!.properties.status).toBe("proposed");
    });
  });

  describe("multi-step proposals on confirm (issue #1486)", () => {
    type Step = NonNullable<ProposalEnvelope["operations"]>[number];
    const confirm = (proposalId: string, actingUserId?: string) =>
      withTransaction(pool, (client) =>
        confirmProposalWithClient(
          client,
          { processingProposalsDatabaseId: proposalsId },
          proposalId,
          undefined,
          actingUserId,
        ),
      );
    const countItems = async (moduleId: string) =>
      (
        await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
          await databaseIdFor(moduleId),
        ])
      ).rows[0]!.n;
    const edgeExists = async (a: string, b: string) =>
      (
        await pool.query(
          "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
          [a, b],
        )
      ).rows.length === 1;
    const createIn = (moduleId: string, properties: Record<string, unknown>) =>
      databaseIdFor(moduleId).then((databaseId) =>
        withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id),
      );
    const cardStatus = async (cardId: string) =>
      (await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId)))!.properties.status;

    /** Stores a multi-step envelope on a fresh card the way the tick will (system-owned `proposal`). */
    async function cardWithSteps(primaryDatabase: string, steps: Step[]): Promise<string> {
      const card = await createDatabaseProposal("seed");
      const primary = steps.find((step) => step.role === "primary")!;
      const target = await databaseIdFor(primaryDatabase);
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: card.id,
            propertiesPatch: {
              proposal: {
                entityKind: "database",
                target,
                properties: primary.properties ?? {},
                operations: steps,
              },
            },
          },
          { allowedSystemKeys: ["proposal"] },
        ),
      );
      return card.id;
    }

    const companyAndPerson = (personName = "Jane"): Step[] => [
      { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: "Acme" } },
      {
        ref: "person",
        op: "create",
        databaseKey: "people",
        role: "secondary",
        properties: { name: personName },
        relations: { companies: [{ ref: "company" }] },
      },
    ];
    // The person is listed before the company it refers to, so execution order must come from the refs.
    const personFirst = (): Step[] => companyAndPerson().reverse();

    it("creates company, person and the People.companies edge in one transaction; the result is the primary's", async () => {
      const card = await cardWithSteps("companies", personFirst());
      const confirmed = await confirm(card);

      expect(await countItems("companies")).toBe(1);
      expect(await countItems("people")).toBe(1);
      const personId = (
        await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [await databaseIdFor("people")])
      ).rows[0]!.id;
      expect(confirmed.properties.resultItemId).not.toBe(personId);
      expect(confirmed.properties.resultLabel).toBe("Acme");
      expect(await edgeExists(personId, confirmed.properties.resultItemId as string)).toBe(true);
      expect(confirmed.properties.status).toBe("confirmed");
    });

    it("rolls back company and edge when the person fails, and the 400 names the person step", async () => {
      // A wrong value type passes envelope validation and fails only in the choke point's write.
      const failing = companyAndPerson();
      failing[1] = { ...failing[1]!, properties: { name: 42 } };
      const failingCard = await cardWithSteps("companies", failing);
      const edgesBefore = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]!.n;

      const error = await confirm(failingCard).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 400, details: { ref: "person" } });
      expect(await countItems("companies")).toBe(0);
      expect(await countItems("people")).toBe(0);
      expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM item_relations")).rows[0]!.n).toBe(
        edgesBefore,
      );
      expect(await cardStatus(failingCard)).toBe("proposed");
    });

    it("writes only the health record when its follow-up task step is disabled", async () => {
      const card = await cardWithSteps("healthRecords", [
        { ref: "record", op: "create", databaseKey: "healthRecords", role: "primary", properties: { name: "Flu" } },
        {
          ref: "followUp",
          op: "create",
          databaseKey: "tasks",
          role: "secondary",
          enabled: false,
          properties: { name: "Call the doctor" },
        },
      ]);
      await confirm(card);
      expect(await countItems("healthRecords")).toBe(1);
      expect(await countItems("tasks")).toBe(0);
    });

    it("creates no person when the optional new person is not referenced", async () => {
      const steps = companyAndPerson();
      steps[1] = { ...steps[1]!, optional: true, relations: {} };
      const card = await cardWithSteps("companies", steps);
      await confirm(card);
      expect(await countItems("companies")).toBe(1);
      expect(await countItems("people")).toBe(0);
    });

    it("an update step moves a project to another area: old edge gone, new edge present", async () => {
      const oldArea = await createIn("areas", { name: "Home" });
      const newArea = await createIn("areas", { name: "Work" });
      const project = await createIn("projects", { name: "Move" });
      await withTransaction(pool, async (client) => {
        const projectsDb = await databaseIdFor("projects");
        const property = await propertiesStore.getPropertyByKey(client, projectsDb, "area");
        await createRelationWithClient(client, {
          relationPropertyId: property!.id,
          callerItemId: project,
          targetItemId: oldArea,
        });
      });
      const card = await cardWithSteps("projects", [
        {
          ref: "project",
          op: "update",
          itemId: project,
          role: "primary",
          properties: { name: "Move" },
          relations: { area: [newArea] },
          before: { properties: { name: "Move" }, relations: { area: [oldArea] } },
          after: { properties: { name: "Move" }, relations: { area: [newArea] } },
        },
      ]);

      const confirmed = await confirm(card);
      expect(confirmed.properties.resultItemId).toBe(project);
      expect(await edgeExists(project, oldArea)).toBe(false);
      expect(await edgeExists(project, newArea)).toBe(true);
    });

    it("an update step's status goes through the choke point; a failing later step restores the old status and edge", async () => {
      const project = await createIn("projects", { name: "Ship" });
      const area = await createIn("areas", { name: "Work" });
      const update: Step = {
        ref: "project",
        op: "update",
        itemId: project,
        role: "primary",
        properties: { status: "done" },
        relations: { area: [area] },
        before: { properties: { status: "inProgress" }, relations: { area: [] } },
        after: { properties: { status: "done" }, relations: { area: [area] } },
      };
      const statusOf = async () =>
        (
          await pool.query<{ status: string }>("SELECT properties->>'status' AS status FROM items WHERE id = $1", [
            project,
          ])
        ).rows[0]!.status;

      const failingCard = await cardWithSteps("projects", [
        update,
        {
          ref: "person",
          op: "create",
          databaseKey: "people",
          role: "secondary",
          properties: { name: 42 },
        },
      ]);
      await expect(confirm(failingCard)).rejects.toMatchObject({ details: { ref: "person" } });
      expect(await statusOf()).toBe("inProgress");
      expect(await edgeExists(project, area)).toBe(false);

      const okCard = await cardWithSteps("projects", [update]);
      await confirm(okCard);
      expect(await statusOf()).toBe("done");
    });

    it("a repeated confirm returns the confirmed card and creates nothing twice", async () => {
      const card = await cardWithSteps("companies", companyAndPerson());
      await confirm(card);
      await confirm(card);
      expect(await countItems("companies")).toBe(1);
      expect(await countItems("people")).toBe(1);
    });

    it("addresses every realtime invalidation of a confirm to the acting user", async () => {
      const card = await cardWithSteps("companies", companyAndPerson());
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        const actingUserId = randomUUID();
        await confirm(card, actingUserId);
        const itemEvents = events.filter((event) => event.scope === "item");
        expect(itemEvents.length).toBeGreaterThanOrEqual(3);
        expect(itemEvents.every((event) => event.userId === actingUserId)).toBe(true);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    describe("item origins (issue #1659)", () => {
      interface OriginRow {
        item_id: string;
        proposal_id: string;
        inbox_item_id: string | null;
        source_transcript_id: string | null;
        captured_at: Date;
        capture_channel: string;
      }
      const originRows = async () => (await pool.query<OriginRow>("SELECT * FROM item_origins ORDER BY item_id")).rows;
      const sourceInboxItemId = (cardId: string) =>
        withTransaction(pool, async (client) => {
          const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
          const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
          const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, cardId);
          return relationsStore.otherSide(edge!, cardId);
        });
      const createdIds = async () =>
        (
          await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = ANY($1)", [
            [await databaseIdFor("companies"), await databaseIdFor("people")],
          ])
        ).rows.map((row) => row.id);

      it("writes one row per created item with the card, the source Inbox item and its capture time", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        await confirm(card);

        const inboxItemId = await sourceInboxItemId(card);
        const [inboxItem] = await withTransaction(pool, (client) => itemsStore.getItemsByIds(client, [inboxItemId]));
        const rows = await originRows();
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.item_id).sort()).toEqual((await createdIds()).sort());
        for (const row of rows) {
          expect(row.proposal_id).toBe(card);
          expect(row.inbox_item_id).toBe(inboxItemId);
          expect(row.source_transcript_id).toBeNull();
          expect(row.capture_channel).toBe("inbox");
          expect(row.captured_at.toISOString()).toBe(
            DateTime.fromISO(`${String(inboxItem!.properties.date)}T${String(inboxItem!.properties.time)}`, {
              zone: await withTransaction(pool, getSystemTimezone),
            })
              .toUTC()
              .toISO(),
          );
        }
      });

      it("writes one row for a single-step database proposal", async () => {
        const card = await createDatabaseProposal("Buy milk");
        const confirmed = await confirm(card.id);
        const rows = await originRows();
        expect(rows.map((row) => row.item_id)).toEqual([confirmed.properties.resultItemId]);
        expect(rows[0]!.proposal_id).toBe(card.id);
      });

      it("writes no row for an item a step only patches", async () => {
        const existing = await createIn("companies", { name: "Existing" });
        const card = await cardWithSteps("companies", [
          {
            ref: "company",
            op: "update",
            itemId: existing,
            role: "primary",
            properties: { name: "Renamed" },
            before: { properties: { name: "Existing" } },
            after: { properties: { name: "Renamed" } },
          },
          {
            ref: "person",
            op: "create",
            databaseKey: "people",
            role: "secondary",
            properties: { name: "Jane" },
            relations: { companies: [{ ref: "company" }] },
          },
        ]);
        await confirm(card);
        const rows = await originRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.item_id).not.toBe(existing);
      });

      it("writes no row when the confirm fails and rolls back", async () => {
        const failing = companyAndPerson();
        failing[1] = { ...failing[1]!, properties: { name: 42 } };
        const card = await cardWithSteps("companies", failing);
        await confirm(card).catch(() => undefined);
        expect(await originRows()).toEqual([]);
      });

      it("a repeated confirm adds and changes no row", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        await confirm(card);
        const before = await originRows();
        await confirm(card);
        expect(await originRows()).toEqual(before);
      });

      it("permanent deletion removes the item's row and keeps the other item's", async () => {
        const card = await cardWithSteps("companies", companyAndPerson());
        const confirmed = await confirm(card);
        const resultId = confirmed.properties.resultItemId as string;
        await withTransaction(pool, async (client) => {
          const [row] = await itemsStore.getItemsByIds(client, [resultId]);
          await itemsStore.hardDeleteItem(client, row!.databaseId, row!.id);
          await deleteItemDependents(client, row!);
        });
        const rows = await originRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.item_id).not.toBe(resultId);
      });
    });
  });

  it("revise transitions a 'needsClarification' proposal (no type at all) to 'proposed' with a valid envelope", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(item.id, async () => {
      throw new Error("computeProposal must not be called for an untyped item");
    });
    const needsClarification = (await findProposalForItem(item.id))!;
    expect(needsClarification.properties.status).toBe("needsClarification");

    const revised = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, needsClarification.id, {
        message: "Filed this under Tasks myself",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
      }),
    );

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksId,
      properties: { name: "Buy milk" },
    });
    const history = revised.properties.history as Array<Record<string, unknown>>;
    expect(history[history.length - 1]).toMatchObject({ author: "user", message: "Filed this under Tasks myself" });
  });

  it("revise refuses a locked (confirmed) proposal", async () => {
    const proposal = await createDatabaseProposal("Buy milk");
    await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
    );

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "too late",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk again" },
        }),
      ),
    ).rejects.toThrow(/Cannot revise a locked proposal/);
  });

  it("revise validates the replacement envelope against current destination state", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "typo fix",
          entityKind: "database",
          target: tasksId,
          properties: { notAKey: "x" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("revise cannot retarget a proposal at Inbox or Inbox item types — the agent's grant excludes them even via a user-supplied envelope (issue #105 review fix)", async () => {
    const proposal = await createDatabaseProposal("Buy milk");

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "retarget to Inbox",
          entityKind: "database",
          target: inboxId,
          properties: {},
        }),
      ),
    ).rejects.toThrow(/not a writable target database/);

    await expect(
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "retarget to Inbox item types",
          entityKind: "database",
          target: typesId,
          properties: {},
        }),
      ),
    ).rejects.toThrow(/not a writable target database/);

    // The proposal must be untouched by the rejected revise attempts — still pointed at Tasks.
    const untouched = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, proposal.id));
    expect((untouched!.properties.proposal as { target: string }).target).toBe(tasksId);
  });

  describe("invalidReason on revise (issue #1482)", () => {
    async function readCard(id: string) {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
    }

    /** Stores `status` `invalid` (with `invalidReason` when given) through the choke point, the state #1916 will write reactively. */
    async function markInvalid(proposalId: string, invalidReason?: Record<string, unknown>) {
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: proposalId,
            propertiesPatch: { status: "invalid", ...(invalidReason ? { invalidReason } : {}) },
          },
          { allowedSystemKeys: ["status", "invalidReason"] },
        ),
      );
    }

    /** A card whose source Inbox item was soft-deleted, so the tick makes it `invalid` with `sourceDeleted`. */
    async function createSourceDeletedCard() {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
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
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
      await runTick(item.id, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      return (await findProposalForItem(item.id))!;
    }

    it("a card invalid for a deleted source is refused on revise, and the card is left unchanged", async () => {
      const card = await createSourceDeletedCard();
      expect(card.properties.status).toBe("invalid");
      expect(card.properties.invalidReason).toMatchObject({ code: "sourceDeleted" });
      const before = await readCard(card.id);

      const attempt = withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
          message: "Use Tasks instead",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
        }),
      );
      const error = await attempt.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toHaveProperty("details", { field: "status" });

      const after = await readCard(card.id);
      expect(after!.properties).toEqual(before!.properties);
      expect(after!.updatedAt).toEqual(before!.updatedAt);
    });

    it("revising a fixable targetArchived card returns it to proposed and clears its reason in the same write", async () => {
      const card = await createDatabaseProposal("Buy milk");
      await markInvalid(card.id, {
        code: "targetArchived",
        field: "project",
        itemId: randomUUID(),
        label: "Website redesign",
      });
      expect((await readCard(card.id))!.properties.invalidReason).toMatchObject({ code: "targetArchived" });

      const revised = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
          message: "Moved it to Tasks",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy milk" },
        }),
      );

      expect(revised.properties.status).toBe("proposed");
      expect(revised.properties.invalidReason).toBeNull();
      expect(revised.properties.proposal).toEqual({
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
      });
    });

    it("a legacy invalid card with no invalidReason is treated as fixable and can be revised", async () => {
      const card = await createDatabaseProposal("Buy milk");
      await markInvalid(card.id);
      expect((await readCard(card.id))!.properties.invalidReason).toBeUndefined();

      const revised = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id, {
          message: "Renamed the task",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk" },
        }),
      );

      expect(revised.properties.status).toBe("proposed");
      expect(revised.properties.invalidReason).toBeNull();
    });
  });

  describe("aiProposal and aiVersion (issue #1471)", () => {
    async function readProposal(id: string) {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, id));
    }

    it("a revise through reviseProposalWithClient stores the new envelope in aiProposal and counts a version", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      expect(proposal.properties.aiVersion).toBe(1);

      const first = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Renamed the task",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk" },
        }),
      );
      expect(first.properties.aiProposal).toEqual({
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy oat milk" },
      });
      expect(first.properties.aiProposal).toEqual(first.properties.proposal);
      expect(first.properties.aiVersion).toBe(2);

      const second = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Renamed it again",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy soy milk" },
        }),
      );
      expect(second.properties.aiProposal).toEqual(second.properties.proposal);
      expect(second.properties.aiVersion).toBe(3);
    });

    it("a revise of a legacy card without aiProposal stores aiProposal and sets aiVersion to 1", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      // A card written before aiProposal and aiVersion existed: no current writer can produce that state.
      await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
        proposal.id,
      ]);

      const revised = await withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, {
          message: "Renamed the task",
          entityKind: "database",
          target: tasksId,
          properties: { name: "Buy oat milk" },
        }),
      );

      expect(revised.properties.aiProposal).toEqual(revised.properties.proposal);
      expect(revised.properties.aiVersion).toBe(1);
    });

    it("confirming a proposal leaves its aiProposal and aiVersion unchanged", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      const before = await readProposal(proposal.id);

      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      );

      const after = await readProposal(proposal.id);
      expect(after!.properties.status).toBe("confirmed");
      expect(after!.properties.aiProposal).toEqual(before!.properties.aiProposal);
      expect(after!.properties.aiVersion).toBe(1);
    });

    it("rejecting a proposal leaves its aiProposal and aiVersion unchanged", async () => {
      const proposal = await createDatabaseProposal("Buy milk");
      const before = await readProposal(proposal.id);

      await withTransaction(pool, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id),
      );

      const after = await readProposal(proposal.id);
      expect(after!.properties.status).toBe("rejected");
      expect(after!.properties.aiProposal).toEqual(before!.properties.aiProposal);
      expect(after!.properties.aiVersion).toBe(1);
    });
  });
});

afterAll(async () => {
  await pool?.end();
});
