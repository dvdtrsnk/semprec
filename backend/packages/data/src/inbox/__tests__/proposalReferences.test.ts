import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../../chokePoint/itemTrash.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import * as propertiesStore from "../../chokePoint/propertiesStore.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { ItemRow } from "../../types.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createSemprecTickAction } from "../inboxTickAction.js";
import { createInboxTypeWithClient } from "../inboxTypesStore.js";
import {
  confirmProposalWithClient,
  lockLiveProposal,
  rejectProposalWithClient,
  updateProposalValuesWithClient,
} from "../proposalActions.js";
import { invalidateProposalsForItem, restoreProposalsForItem } from "../proposalReferenceInvalidation.js";

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

const idOf = async (moduleId: string) => {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
};

const historyEntries = z.array(z.object({ author: z.string(), kind: z.string().optional(), message: z.string() }));

describe("the hooks that invalidate and restore the open proposals of an item (issue #1916)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let projectsId: string;
  let peopleId: string;
  let taskTypeId: string;
  let tenant: string;

  // The value-link resolver that the update hooks reach (a Projects `status` patch) refuses a write with no tenant scope,
  // so a test runs in the scope of the tenant `beforeEach` created and seeded.
  const tenantIt = (name: string, test: () => Promise<void>) => it(name, () => runInTenant(tenant, test));
  tenantIt.each =
    <T>(cases: readonly T[]) =>
    (name: string, test: (value: T) => Promise<void>) =>
      it.each(cases)(name, (value) => runInTenant(tenant, () => test(value)));

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenant = await createTestTenant(pool);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    inboxId = await idOf("inbox");
    typesId = await idOf("inboxItemTypes");
    proposalsId = await idOf("processingProposals");
    projectsId = await idOf("projects");
    peopleId = await idOf("people");
    taskTypeId = (
      await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          createInboxTypeWithClient(client, {
            inboxItemTypesDatabaseId: typesId,
            name: "Task",
            emoji: "☑️",
            processingMethod: "database",
            targetDatabase: "tasks",
          }),
        ),
      )
    ).id;
  });

  const config = () => ({ processingProposalsDatabaseId: proposalsId });

  const createProject = (name: string) =>
    withTransaction(
      pool,
      async (client) => (await createItemWithClient(client, { databaseId: projectsId, properties: { name } })).id,
    );

  const setProjectStatus = (projectId: string, status: string) =>
    withTransaction(pool, (client) =>
      updateItemWithClient(client, {
        databaseId: projectsId,
        itemId: projectId,
        propertiesPatch: { status },
      }),
    );

  /** An open task proposal made by the tick, in `project` when one is given. */
  async function createTaskCard(project: string | null, text = "Buy milk"): Promise<string> {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: taskTypeId,
      }),
    );
    const tick = createSemprecTickAction(pool, async () => ({
      properties: { name: text },
      ...(project === null ? {} : { relations: { project: [project] } }),
    }));
    await tick(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    const card = await withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
      const edges = await relationsStore.listRelationsForItem(client, definition!.id, item.id);
      return edges[0] ? relationsStore.otherSide(edges[0], item.id) : null;
    });
    if (card === null) throw new Error("the tick created no card");
    return card;
  }

  /** A card of a state no route produces from the outside, written as the system writer does. */
  const storeOnCard = (cardId: string, patch: Record<string, unknown>) =>
    withTransaction(pool, (client) =>
      updateItemWithClient(
        client,
        { databaseId: proposalsId, itemId: cardId, propertiesPatch: patch },
        { allowedSystemKeys: Object.keys(patch) },
      ),
    );

  const readCard = async (cardId: string): Promise<ItemRow> => {
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId));
    if (!card) throw new Error(`card ${cardId} not found`);
    return card;
  };
  const historyOf = (card: ItemRow) => historyEntries.parse(card.properties.history);

  tenantIt(
    "archiving a project turns the open task proposal invalid, with the reason and its field, in the same transaction",
    async () => {
      const project = await createProject("Alpha");
      const card = await createTaskCard(project);
      expect((await readCard(card)).properties).toMatchObject({ status: "proposed", referencedItemIds: [project] });

      const inside = await withTransaction(pool, async (client) => {
        await updateItemWithClient(client, {
          databaseId: projectsId,
          itemId: project,
          propertiesPatch: { status: "archived" },
        });
        return itemsStore.getItemById(client, proposalsId, card);
      });

      expect(inside?.properties.status).toBe("invalid");
      expect(inside?.properties.invalidReason).toEqual({
        code: "targetArchived",
        field: "project",
        itemId: project,
        label: "Alpha",
      });
      const stored = await readCard(card);
      expect(stored.properties.status).toBe("invalid");
      expect(historyOf(stored).at(-1)).toMatchObject({ author: "ai", kind: "invalidated" });
    },
  );

  tenantIt("rolls the invalidation back with the archive when the transaction fails", async () => {
    const project = await createProject("Alpha");
    const card = await createTaskCard(project);
    const before = await readCard(card);

    await expect(
      withTransaction(pool, async (client) => {
        await updateItemWithClient(client, {
          databaseId: projectsId,
          itemId: project,
          propertiesPatch: { status: "archived" },
        });
        throw new Error("abort after the archive");
      }),
    ).rejects.toThrow("abort after the archive");

    expect(await readCard(card)).toEqual(before);
    const stored = await withTransaction(pool, (client) => itemsStore.getItemById(client, projectsId, project));
    expect(stored?.properties.status).not.toBe("archived");
  });

  tenantIt("invalidates only the cards that refer to the archived project", async () => {
    const [alpha, beta] = [await createProject("Alpha"), await createProject("Beta")];
    const [inAlpha, inBeta, inNone] = [
      await createTaskCard(alpha, "One"),
      await createTaskCard(beta, "Two"),
      await createTaskCard(null, "Three"),
    ];
    const betaBefore = await readCard(inBeta);
    const noneBefore = await readCard(inNone);

    await setProjectStatus(alpha, "archived");

    expect((await readCard(inAlpha)).properties.status).toBe("invalid");
    expect(await readCard(inBeta)).toEqual(betaBefore);
    expect(await readCard(inNone)).toEqual(noneBefore);
  });

  tenantIt("returns the card to proposed when another project is chosen with the values edit", async () => {
    const [archived, other] = [await createProject("Alpha"), await createProject("Beta")];
    const card = await createTaskCard(archived);
    await setProjectStatus(archived, "archived");
    expect((await readCard(card)).properties.status).toBe("invalid");

    const edited = await withTransaction(pool, (client) =>
      updateProposalValuesWithClient(client, config(), card, { relations: { primary: { project: [other] } } }),
    );

    expect(edited.item.properties).toMatchObject({
      status: "proposed",
      invalidReason: null,
      referencedItemIds: [other],
    });
    await setProjectStatus(other, "archived");
    expect((await readCard(card)).properties.invalidReason).toMatchObject({ code: "targetArchived", itemId: other });
  });

  tenantIt.each(["inProgress", "done"])(
    "returns the card to proposed with a reopened entry when the archived project becomes %s",
    async (status) => {
      const project = await createProject("Alpha");
      const card = await createTaskCard(project);
      await setProjectStatus(project, "archived");

      await setProjectStatus(project, status);

      const restored = await readCard(card);
      expect(restored.properties).toMatchObject({ status: "proposed", invalidReason: null });
      expect(historyOf(restored).at(-1)).toMatchObject({ author: "ai", kind: "reopened" });
      expect(historyOf(restored).filter((entry) => entry.kind === "invalidated")).toHaveLength(1);
    },
  );

  tenantIt(
    "leaves the card proposed when its project becomes done, because a done project stays a valid target",
    async () => {
      const project = await createProject("Alpha");
      const card = await createTaskCard(project);
      const before = await readCard(card);

      await setProjectStatus(project, "done");

      expect(await readCard(card)).toEqual(before);
    },
  );

  tenantIt("keeps the card invalid when its stored envelope no longer validates once the project is back", async () => {
    const project = await createProject("Alpha");
    const card = await createTaskCard(project);
    await setProjectStatus(project, "archived");
    // An envelope that no longer fits its destination (a property that was removed): no route stores one.
    const stored = (await readCard(card)).properties.proposal as Record<string, unknown>;
    await storeOnCard(card, { proposal: { ...stored, properties: { name: "Buy milk", noSuchProperty: 1 } } });

    await setProjectStatus(project, "inProgress");

    const after = await readCard(card);
    expect(after.properties.status).toBe("invalid");
    expect(after.properties.invalidReason).toMatchObject({ code: "targetArchived", itemId: project });
    expect(historyOf(after).filter((entry) => entry.kind === "reopened")).toEqual([]);
  });

  tenantIt("does not return a card that is invalid for another reason when the project is back", async () => {
    const project = await createProject("Alpha");
    const card = await createTaskCard(project);
    await storeOnCard(card, {
      status: "invalid",
      invalidReason: { code: "targetDeleted", field: "project", itemId: project, label: "Alpha" },
    });
    const before = await readCard(card);

    await setProjectStatus(project, "archived");
    await setProjectStatus(project, "inProgress");

    expect(await readCard(card)).toEqual(before);
  });

  tenantIt(
    "leaves a confirmed, a rejected and an already invalid card alone when the project is archived",
    async () => {
      const project = await createProject("Alpha");
      const [confirmed, rejected, invalid] = [
        await createTaskCard(project, "One"),
        await createTaskCard(project, "Two"),
        await createTaskCard(project, "Three"),
      ];
      await withTransaction(pool, (client) => confirmProposalWithClient(client, config(), confirmed));
      await withTransaction(pool, (client) => rejectProposalWithClient(client, config(), rejected));
      await storeOnCard(invalid, {
        status: "invalid",
        invalidReason: { code: "sourceDeleted", field: "", itemId: randomUUID(), label: "Source" },
      });
      const before = await Promise.all([confirmed, rejected, invalid].map(readCard));

      await setProjectStatus(project, "archived");
      await setProjectStatus(project, "inProgress");

      expect(await Promise.all([confirmed, rejected, invalid].map(readCard))).toEqual(before);
    },
  );

  /** A speaker card proposing to link `personId`, as `proposeSpeakerMappings` stores it (its own test covers the producer). */
  async function createSpeakerCard(personId: string): Promise<string> {
    const envelope = {
      entityKind: "relation",
      target: personId,
      properties: { propertyKey: "speakers", metadata: { speaker: "SPEAKER_00" } },
    };
    return withTransaction(pool, async (client) => {
      const card = await createItemWithClient(
        client,
        {
          databaseId: proposalsId,
          properties: {
            kind: "transcript",
            status: "proposed",
            proposal: envelope,
            aiProposal: envelope,
            aiVersion: 1,
            referencedItemIds: [personId],
          },
        },
        { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal", "aiVersion", "referencedItemIds"] },
      );
      return card.id;
    });
  }

  const deletePerson = (personId: string) =>
    withTransaction(pool, (client) =>
      itemDeleteWithClient(client, peopleId, personId, { queueAffinity: createActionQueueAffinity() }),
    );
  const restorePerson = (personId: string) =>
    withTransaction(pool, (client) => restoreItemWithClient(client, peopleId, personId, createActionQueueAffinity()));
  const createPerson = (name: string) =>
    withTransaction(
      pool,
      async (client) => (await createItemWithClient(client, { databaseId: peopleId, properties: { name } })).id,
    );

  tenantIt(
    "turns the open card of a deleted person invalid with targetDeleted and returns it to proposed when the person is restored",
    async () => {
      const [alice, bob] = [await createPerson("Alice"), await createPerson("Bob")];
      const [aliceCard, bobCard] = [await createSpeakerCard(alice), await createSpeakerCard(bob)];
      const bobBefore = await readCard(bobCard);

      await deletePerson(alice);

      const invalid = await readCard(aliceCard);
      expect(invalid.properties.status).toBe("invalid");
      expect(invalid.properties.invalidReason).toEqual({
        code: "targetDeleted",
        field: "target",
        itemId: alice,
        label: "Alice",
      });
      expect(historyOf(invalid).at(-1)).toMatchObject({ author: "ai", kind: "invalidated" });
      expect(await readCard(bobCard)).toEqual(bobBefore);

      await restorePerson(alice);

      const restored = await readCard(aliceCard);
      expect(restored.properties).toMatchObject({ status: "proposed", invalidReason: null });
      expect(historyOf(restored).at(-1)).toMatchObject({ author: "ai", kind: "reopened" });
    },
  );

  tenantIt(
    "does not return a card of a deleted person that was archived for a project, and the other way round",
    async () => {
      const person = await createPerson("Alice");
      const card = await createSpeakerCard(person);
      await storeOnCard(card, {
        status: "invalid",
        invalidReason: { code: "targetArchived", field: "target", itemId: person, label: "Alice" },
      });
      const before = await readCard(card);

      await deletePerson(person);
      await restorePerson(person);

      expect(await readCard(card)).toEqual(before);
    },
  );

  tenantIt("trims a long label to 80 code points, and uses an empty label for an item with no title", async () => {
    const long = await createPerson("Ž".repeat(120));
    const longCard = await createSpeakerCard(long);

    await deletePerson(long);

    const label = z.object({ label: z.string() }).parse((await readCard(longCard)).properties.invalidReason).label;
    expect(Array.from(label)).toHaveLength(80);
    expect(label.endsWith("…")).toBe(true);

    const untitled = await withTransaction(
      pool,
      async (client) => (await createItemWithClient(client, { databaseId: peopleId, properties: {} })).id,
    );
    const untitledCard = await createSpeakerCard(untitled);

    await deletePerson(untitled);

    expect((await readCard(untitledCard)).properties.invalidReason).toMatchObject({ label: "" });
  });

  tenantIt("names no field for a card whose envelope does not name the item", async () => {
    const project = await createProject("Alpha");
    const person = await createPerson("Alice");
    const card = await createTaskCard(project);
    // The card lists a person its envelope does not name: a state only a hand-edited card has.
    await storeOnCard(card, { referencedItemIds: [project, person] });

    await deletePerson(person);

    expect((await readCard(card)).properties.invalidReason).toMatchObject({
      code: "targetDeleted",
      field: "",
      itemId: person,
    });
  });

  tenantIt("does not wait for a card that another transaction holds the lock of, and does not change it", async () => {
    const project = await createProject("Alpha");
    const card = await createTaskCard(project);
    const before = await readCard(card);
    // The lock a confirm takes first.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await lockLiveProposal(holder, proposalsId, card);

      await withTransaction(pool, async (client) => {
        // A hook that waited for the card would run into this limit and fail the archive.
        await client.query("SET LOCAL lock_timeout = '2s'");
        await updateItemWithClient(client, {
          databaseId: projectsId,
          itemId: project,
          propertiesPatch: { status: "archived" },
        });
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    expect(await readCard(card)).toEqual(before);
  });

  tenantIt(
    "does not wait for an invalid card that another transaction holds the lock of when the project is back, and keeps it invalid",
    async () => {
      const project = await createProject("Alpha");
      const card = await createTaskCard(project);
      await setProjectStatus(project, "archived");
      const before = await readCard(card);
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await lockLiveProposal(holder, proposalsId, card);

        await withTransaction(pool, async (client) => {
          await client.query("SET LOCAL lock_timeout = '2s'");
          await updateItemWithClient(client, {
            databaseId: projectsId,
            itemId: project,
            propertiesPatch: { status: "inProgress" },
          });
        });
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }

      expect(await readCard(card)).toEqual(before);
    },
  );

  /** The step of an "archive this project" card: it updates `projectId` and sets its status to `archived`. */
  const archiveStep = (projectId: string) => ({
    ref: "archive",
    op: "update" as const,
    itemId: projectId,
    role: "primary" as const,
    properties: { status: "archived" },
    before: { properties: { status: "inProgress" } },
    after: { properties: { status: "archived" } },
  });

  /** An open card whose multi-step envelope archives `projectId` when confirmed, stored as the writers store a proposal. */
  async function createArchiveProjectCard(projectId: string): Promise<string> {
    const card = await createTaskCard(projectId);
    const stored = (await readCard(card)).properties.proposal as Record<string, unknown>;
    await storeOnCard(card, {
      proposal: {
        ...stored,
        target: projectsId,
        properties: { status: "archived" },
        relations: undefined,
        operations: [archiveStep(projectId)],
      },
      referencedItemIds: [projectId],
    });
    return card;
  }

  tenantIt(
    "leaves the card alone that the same transaction is confirming when a step of the confirm archives the project it refers to",
    async () => {
      const project = await createProject("Alpha");
      await setProjectStatus(project, "inProgress");
      const card = await createArchiveProjectCard(project);
      const other = await createTaskCard(project, "Other card of the project");

      await withTransaction(pool, (client) => confirmProposalWithClient(client, config(), card));

      const confirmed = await readCard(card);
      expect(confirmed.properties).toMatchObject({ status: "confirmed", resultItemId: project });
      expect(confirmed.properties.invalidReason ?? null).toBeNull();
      expect(historyEntries.parse(confirmed.properties.history).map((entry) => entry.kind)).not.toContain(
        "invalidated",
      );
      expect(
        (await withTransaction(pool, (client) => itemsStore.getItemById(client, projectsId, project)))?.properties
          .status,
      ).toBe("archived");
      // Another card of the project is not the one being confirmed: it is invalidated as the archive always does.
      expect((await readCard(other)).properties).toMatchObject({
        status: "invalid",
        invalidReason: { code: "targetArchived", itemId: project },
      });
    },
  );

  tenantIt(
    "keeps the card invalid, and does not fail the restore, when revalidating its envelope is refused for an archived database",
    async () => {
      const project = await createProject("Alpha");
      const healthRecordsId = await idOf("healthRecords");
      const record = await withTransaction(
        pool,
        async (client) =>
          (await createItemWithClient(client, { databaseId: healthRecordsId, properties: { name: "Blood test" } })).id,
      );
      const card = await createTaskCard(project);
      const stored = (await readCard(card)).properties.proposal as Record<string, unknown>;
      await storeOnCard(card, {
        proposal: { ...stored, relations: { project: [project], healthRecords: [record] } },
        referencedItemIds: [project, record],
      });
      await withTransaction(pool, (client) =>
        itemDeleteWithClient(client, healthRecordsId, record, { queueAffinity: createActionQueueAffinity() }),
      );
      expect((await readCard(card)).properties.invalidReason).toMatchObject({ code: "targetDeleted", itemId: record });
      // The Projects database the envelope links into is archived since; no route archives a system database.
      await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [projectsId]);
      const before = await readCard(card);

      await withTransaction(pool, (client) =>
        restoreItemWithClient(client, healthRecordsId, record, createActionQueueAffinity()),
      );

      expect(await readCard(card)).toEqual(before);
      expect((await readCard(card)).properties.status).toBe("invalid");
      expect(
        (await withTransaction(pool, (client) => itemsStore.getItemById(client, healthRecordsId, record)))?.deletedAt,
      ).toBeNull();
    },
  );

  tenantIt("changes no card when the Processing proposals database is not there", async () => {
    const project = await createProject("Alpha");
    const person = await createPerson("Alice");
    const card = await createTaskCard(project);
    const before = await readCard(card);
    // No API removes a system database: a raw write takes the Processing proposals database out of the module lookup.
    await pool.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [proposalsId]);

    await setProjectStatus(project, "archived");
    await deletePerson(person);
    await restorePerson(person);
    await setProjectStatus(project, "inProgress");

    expect(await readCard(card)).toEqual(before);
  });

  tenantIt(
    "writes an empty label for an item that does not exist, and returns the card when its envelope is valid",
    async () => {
      const card = await createTaskCard(null);
      const unknown = randomUUID();
      await storeOnCard(card, { referencedItemIds: [unknown] });

      await withTransaction(pool, (client) => invalidateProposalsForItem(client, config(), unknown, "targetDeleted"));

      expect((await readCard(card)).properties.invalidReason).toMatchObject({ itemId: unknown, label: "" });

      await withTransaction(pool, (client) => restoreProposalsForItem(client, config(), unknown, "targetDeleted"));

      expect((await readCard(card)).properties).toMatchObject({ status: "proposed", invalidReason: null });
    },
  );
});

describe("the hooks keep to the tenant of the write (issue #1916)", () => {
  it("never invalidates another tenant's proposal, and invalidates the tenant's own", async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const [tenantA, tenantB] = [await createTestTenant(pool), await createTestTenant(pool)];
      for (const tenant of [tenantA, tenantB]) {
        await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
      }
      const inTenant = <T>(tenant: string, fn: (client: import("pg").PoolClient) => Promise<T>) =>
        runInTenant(tenant, () => withTransaction(runtime, fn));
      const projectB = await inTenant(tenantB, async (client) => {
        const projects = await getDatabaseByModuleId(client, "projects");
        return (await createItemWithClient(client, { databaseId: projects!.id, properties: { name: "Beta" } })).id;
      });
      // Both tenants hold an open card that lists tenant B's project id; tenant A cannot link it, so its card is a fixture.
      const cardIn = (tenant: string) =>
        inTenant(tenant, async (client) => {
          const proposals = await getDatabaseByModuleId(client, "processingProposals");
          const tasks = await getDatabaseByModuleId(client, "tasks");
          const envelope = { entityKind: "database", target: tasks!.id, properties: { name: "Task" } };
          const card = await createItemWithClient(
            client,
            {
              databaseId: proposals!.id,
              properties: {
                kind: "inbox",
                status: "proposed",
                proposal: envelope,
                aiProposal: envelope,
                referencedItemIds: [projectB],
              },
            },
            { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal", "referencedItemIds"] },
          );
          return card.id;
        });
      const [cardA, cardB] = [await cardIn(tenantA), await cardIn(tenantB)];
      const statusOf = (tenant: string, card: string) =>
        inTenant(tenant, async (client) => {
          const proposals = await getDatabaseByModuleId(client, "processingProposals");
          return (await itemsStore.getItemById(client, proposals!.id, card))?.properties.status;
        });

      await inTenant(tenantB, async (client) => {
        const projects = await getDatabaseByModuleId(client, "projects");
        await updateItemWithClient(client, {
          databaseId: projects!.id,
          itemId: projectB,
          propertiesPatch: { status: "archived" },
        });
      });

      expect(await statusOf(tenantB, cardB)).toBe("invalid");
      expect(await statusOf(tenantA, cardA)).toBe("proposed");
    } finally {
      await runtime.end();
    }
  });
});
