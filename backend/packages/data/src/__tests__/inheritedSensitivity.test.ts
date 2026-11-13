import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { assertAgentDatabaseAccess, assertReaderDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { allowItemsForTurn } from "../agentGrants/agentRunReadAllowancesStore.js";
import {
  itemIdsLinkedToDatabases,
  sensitiveSourceDatabaseIds,
  sensitiveSourceDatabaseIdsByItem,
} from "../agentGrants/inheritedSensitivity.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { createUser } from "../auth/usersStore.js";
import { computeDestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertValueLink } from "../chokePoint/valueLinksStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { createDocStore } from "../docs/docStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { assertAgentPageAccess } from "../docs/pageOwnerDatabase.js";
import { readSempRefContext } from "../semp/sempRefReadContext.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SENSITIVE_DATABASE_KEYS, SENSITIVITY_INHERITING_MODULE_IDS } from "../seed/sensitiveDatabaseKeys.js";
import {
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  TASKS_MODULE_ID,
  TRANSCRIPTS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { SLEEP_NIGHTS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow, ItemRow, PropertyRow } from "../types.js";
import type { RelationExpansionOptions } from "../chokePoint/relationExpansion.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";

// Seeding the system databases of one tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };

let adminPool: Pool;
let dataPool: Pool;
let cp: ChokePoint;
let tenantId: string;
let health: DatabaseRow;
let sleepNights: DatabaseRow;
let files: DatabaseRow;
let transcripts: DatabaseRow;
let inbox: DatabaseRow;
let attachments: DatabaseRow;
/** Files.healthRecords: the file is the A end of the edge (`item_a`). */
let fileToHealth: PropertyRow;
/** Health records.attachedFiles: the file is the B end of the edge (`item_b`). */
let healthToFile: PropertyRow;
let fileToNight: PropertyRow;
let transcriptToHealth: PropertyRow;
let inboxToHealth: PropertyRow;
let attachmentToFile: PropertyRow;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenantId, fn);
}

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(dataPool, fn));
}

/** An agent run's writer: the identity `writerIdentityOf` derives for a run credential. */
function agent(projectItemId: string): WriterIdentity & { writerKind: "agent" } {
  return { writerKind: "agent", agentRunId: randomUUID(), agentProjectItemId: projectItemId };
}

function newProject(): Promise<string> {
  return inTenant(() => createTestProjectItem(dataPool));
}

function setGrant(projectItemId: string, databaseId: string, access: AgentDatabaseAccess) {
  return inTransaction((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access }));
}

async function systemDatabase(moduleId: string): Promise<DatabaseRow> {
  const database = await inTransaction((client) => getDatabaseByModuleId(client, moduleId));
  if (!database) throw new Error(`System database ${moduleId} is missing`);
  return database;
}

async function propertyOf(database: DatabaseRow, key: string): Promise<PropertyRow> {
  const property = (await inTenant(() => cp.listProperties(database.id))).find((candidate) => candidate.key === key);
  if (!property) throw new Error(`Property ${key} of ${database.id} is missing`);
  return property;
}

const newRecord = (name = "Private diagnosis") =>
  inTenant(() => cp.createItem({ databaseId: health.id, properties: { name } }));
let nightCounter = 0;
/** A night exception on a date no other call of this file used: a night is unique per date. */
const newNight = () => {
  const night = new Date(Date.UTC(2030, 0, 1 + nightCounter++)).toISOString().slice(0, 10);
  return inTenant(() =>
    cp.createItem({
      databaseId: sleepNights.id,
      properties: { night, bedTime: "23:15", wakeTime: "06:40", alarm: true },
    }),
  );
};
const newFile = (name = "Scan.pdf") => inTenant(() => cp.createItem({ databaseId: files.id, properties: { name } }));
const newTranscript = (name = "Doctor visit") =>
  inTenant(() => cp.createItem({ databaseId: transcripts.id, properties: { name } }));
const newInboxEntry = (text = "Visit note") =>
  inTenant(() => cp.createItem({ databaseId: inbox.id, properties: { date: "2026-11-01", time: "10:00", text } }));

/** Links `caller` to `target` through `property` and returns the edge, so a test can remove it again. */
async function link(property: PropertyRow, caller: ItemRow, target: ItemRow) {
  await inTenant(() =>
    cp.createRelation({ relationPropertyId: property.id, callerItemId: caller.id, targetItemId: target.id }),
  );
  return { relationPropertyId: property.id, callerItemId: caller.id, targetItemId: target.id };
}

function unlink(edge: Awaited<ReturnType<typeof link>>) {
  return inTenant(() => cp.deleteRelation(edge));
}

function ids(page: { items: ItemRow[] }): string[] {
  return page.items.map((item) => item.id);
}

describe("sensitivity inherited through relation edges (issue #1999)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    // An agent run needs a user in the tenant.
    await createUser(adminPool, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await inTenant(() => seedSystem(dataPool, createViewTypeRegistry()));
    cp = createChokePoint(dataPool);
    health = await systemDatabase(HEALTH_RECORDS_MODULE_ID);
    sleepNights = await systemDatabase(SLEEP_NIGHTS_MODULE_ID);
    files = await systemDatabase(FILES_MODULE_ID);
    transcripts = await systemDatabase(TRANSCRIPTS_MODULE_ID);
    inbox = await systemDatabase(INBOX_MODULE_ID);
    fileToHealth = await propertyOf(files, "healthRecords");

    // A fixture the API cannot produce: the schemas of the system databases are locked until a code-level
    // migration changes them, and no system database has a relation to Transcripts, Inbox or (from the Health
    // side) Files yet. The superuser pool unlocks them so the relation properties below are created through
    // the choke point as a user would create them.
    await adminPool.query("UPDATE databases SET schema_locked = false WHERE id = ANY($1::uuid[])", [
      [health.id, files.id, transcripts.id, inbox.id],
    ]);
    attachments = await inTenant(async () => {
      const database = await cp.createDatabase({ name: "Attachments" });
      await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
      return database;
    });
    const createRelation = async (source: DatabaseRow, key: string, target: DatabaseRow, inverseKey?: string) =>
      (
        await inTenant(() =>
          cp.createRelationProperty({
            sourceDatabaseId: source.id,
            key,
            name: key,
            targetDatabaseId: target.id,
            ...(inverseKey ? { inverse: { key: inverseKey, name: inverseKey } } : {}),
          }),
        )
      ).property;
    healthToFile = await createRelation(health, "attachedFiles", files, "attachedToRecords");
    fileToNight = await createRelation(files, "nights", sleepNights);
    transcriptToHealth = await createRelation(transcripts, "diagnoses", health);
    inboxToHealth = await createRelation(inbox, "diagnoses", health);
    attachmentToFile = await createRelation(attachments, "files", files);
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await dataPool?.end();
  });

  it("names the inheriting databases next to the sensitive keys and none of them is sensitive itself", () => {
    expect(SENSITIVITY_INHERITING_MODULE_IDS).toEqual([FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID, INBOX_MODULE_ID]);
    for (const moduleId of SENSITIVITY_INHERITING_MODULE_IDS) {
      expect(SENSITIVE_DATABASE_KEYS).not.toContain(moduleId);
    }
    expect([health, sleepNights].map((database) => database.sensitive)).toEqual([true, true]);
    expect([files, transcripts, inbox].map((database) => database.sensitive)).toEqual([false, false, false]);
  });

  describe("sensitiveSourceDatabaseIds", () => {
    const sources = (itemId: string) => inTransaction((client) => sensitiveSourceDatabaseIds(client, itemId));

    it("returns the sensitive database of a record the item is linked to, from either end of the edge", async () => {
      const [aEnd, bEnd] = [await newFile(), await newFile()];
      await link(fileToHealth, aEnd, await newRecord());
      await link(healthToFile, await newRecord(), bEnd);
      expect(await sources(aEnd.id)).toEqual([health.id]);
      expect(await sources(bEnd.id)).toEqual([health.id]);
    });

    it("returns every sensitive database the item is linked to once, and ignores a link to a non-sensitive item", async () => {
      const file = await newFile();
      await link(fileToHealth, file, await newRecord());
      await link(fileToHealth, file, await newRecord());
      await link(fileToNight, file, await newNight());
      await link(
        attachmentToFile,
        await inTenant(() => cp.createItem({ databaseId: attachments.id, properties: { name: "A" } })),
        file,
      );
      expect([...(await sources(file.id))].sort()).toEqual([health.id, sleepNights.id].sort());
    });

    it("returns nothing for an item without a link, and for a file linked only to an item of a non-sensitive database", async () => {
      const linkedToOpen = await newFile();
      await link(
        attachmentToFile,
        await inTenant(() => cp.createItem({ databaseId: attachments.id, properties: { name: "B" } })),
        linkedToOpen,
      );
      expect(await sources(linkedToOpen.id)).toEqual([]);
      expect(await sources((await newFile()).id)).toEqual([]);
      expect(await sources(randomUUID())).toEqual([]);
    });

    it("returns nothing for an item of a database that does not inherit, although it is linked to a sensitive record", async () => {
      const record = await newRecord();
      const attachment = await inTenant(() => cp.createItem({ databaseId: attachments.id, properties: { name: "C" } }));
      const toHealth = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: attachments.id,
          key: "records",
          name: "Records",
          targetDatabaseId: health.id,
        }),
      );
      await link(toHealth.property, attachment, record);
      expect(await sources(attachment.id)).toEqual([]);
    });

    it("returns nothing for an item of a user-created database that carries the owner module id of Files", async () => {
      const lookalike = await inTenant(() =>
        cp.createDatabase({ name: "Files lookalike", ownerModuleId: FILES_MODULE_ID }),
      );
      await inTenant(() => cp.createProperty({ databaseId: lookalike.id, key: "name", name: "Name", type: "title" }));
      expect(lookalike.system).toBe(false);
      const toHealth = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: lookalike.id,
          key: "records",
          name: "Records",
          targetDatabaseId: health.id,
        }),
      );
      const item = await inTenant(() => cp.createItem({ databaseId: lookalike.id, properties: { name: "L" } }));
      await link(toHealth.property, item, await newRecord());
      expect(await sources(item.id)).toEqual([]);
    });

    it("ignores a record in the trash and counts it again when it is restored", async () => {
      const file = await newFile();
      const record = await newRecord();
      await link(fileToHealth, file, record);
      expect(await sources(file.id)).toEqual([health.id]);
      await inTenant(() => cp.softDeleteItem(health.id, record.id));
      expect(await sources(file.id)).toEqual([]);
      await inTenant(() => cp.restoreItem(health.id, record.id));
      expect(await sources(file.id)).toEqual([health.id]);
    });

    it("stays sensitive when the item itself is in the trash", async () => {
      const file = await newFile();
      await link(fileToHealth, file, await newRecord());
      await inTenant(() => cp.softDeleteItem(files.id, file.id));
      expect(await sources(file.id)).toEqual([health.id]);
    });

    it("stops after the edge is removed", async () => {
      const file = await newFile();
      const edge = await link(fileToHealth, file, await newRecord());
      expect(await sources(file.id)).toEqual([health.id]);
      await unlink(edge);
      expect(await sources(file.id)).toEqual([]);
    });

    it("returns the links of a transcript and of an Inbox entry", async () => {
      const [transcript, entry] = [await newTranscript(), await newInboxEntry()];
      await link(transcriptToHealth, transcript, await newRecord());
      await link(inboxToHealth, entry, await newRecord());
      expect(await sources(transcript.id)).toEqual([health.id]);
      expect(await sources(entry.id)).toEqual([health.id]);
    });

    it("sees nothing of another tenant's items", async () => {
      const file = await newFile();
      await link(fileToHealth, file, await newRecord());
      const otherTenantId = await createTestTenant(adminPool);
      const seen = await runInTenant(otherTenantId, () =>
        withTransaction(dataPool, (client) => sensitiveSourceDatabaseIds(client, file.id)),
      );
      expect(seen).toEqual([]);
    });

    it("answers an empty list of items without a query and groups a list by item", async () => {
      const [first, second, unlinked] = [await newFile(), await newFile(), await newFile()];
      await link(fileToHealth, first, await newRecord());
      await link(fileToNight, second, await newNight());
      expect(await inTransaction((client) => sensitiveSourceDatabaseIdsByItem(client, []))).toEqual(new Map());
      const grouped = await inTransaction((client) =>
        sensitiveSourceDatabaseIdsByItem(client, [first.id, second.id, unlinked.id]),
      );
      expect(grouped).toEqual(
        new Map([
          [first.id, [health.id]],
          [second.id, [sleepNights.id]],
        ]),
      );
    });

    it("selects the items linked to one of the given databases only", async () => {
      const [first, second] = [await newFile(), await newFile()];
      await link(fileToHealth, first, await newRecord());
      await link(fileToNight, second, await newNight());
      const linked = (databaseIds: string[]) =>
        inTransaction((client) => itemIdsLinkedToDatabases(client, [first.id, second.id], new Set(databaseIds)));
      expect(await linked([])).toEqual(new Set());
      expect(await linked([health.id])).toEqual(new Set([first.id]));
      expect(await linked([sleepNights.id, health.id])).toEqual(new Set([first.id, second.id]));
      expect(await linked([randomUUID()])).toEqual(new Set());
    });
  });

  describe("the access decision for an item", () => {
    const check = (project: string, item: ItemRow, access: "read" | "write", client?: PoolClient) => {
      const run = (c: PoolClient) =>
        assertAgentDatabaseAccess(c, {
          agentProjectItemId: project,
          databaseId: item.databaseId,
          access,
          itemId: item.id,
        });
      return client ? run(client) : inTransaction(run);
    };

    it("refuses a linked file to a project without a grant on the record's database and opens it with read for a read and write for both", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      await expect(check(project, file, "read")).rejects.toMatchObject(FORBIDDEN);
      await expect(check(project, file, "write")).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "read");
      await check(project, file, "read");
      await expect(check(project, file, "write")).rejects.toMatchObject(FORBIDDEN);

      await setGrant(project, health.id, "write");
      await check(project, file, "read");
      await check(project, file, "write");

      await setGrant(project, health.id, "none");
      await expect(check(project, file, "read")).rejects.toMatchObject(FORBIDDEN);
    });

    it("needs the access on every sensitive database the file is linked to", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      await link(fileToNight, file, await newNight());
      await setGrant(project, health.id, "read");
      await expect(check(project, file, "read")).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, sleepNights.id, "read");
      await check(project, file, "read");
    });

    it("leaves an unlinked file, a file linked to an open item and a decision of another project alone", async () => {
      const [project, other, file] = [await newProject(), await newProject(), await newFile()];
      await check(project, file, "write");
      await link(fileToHealth, file, await newRecord());
      await setGrant(other, health.id, "write");
      await expect(check(project, file, "read")).rejects.toMatchObject(FORBIDDEN);
      await check(other, file, "write");
    });

    it("keeps the refusal free of the item's content and of the database it is linked to", async () => {
      const [project, file] = [await newProject(), await newFile("Secret scan xyz")];
      await link(fileToHealth, file, await newRecord());
      const refusal = await check(project, file, "read").catch((error: unknown) => error);
      expect(refusal).toMatchObject(FORBIDDEN);
      const text = JSON.stringify({ message: String(refusal), details: Reflect.get(Object(refusal), "details") });
      expect(text).not.toContain("Secret scan");
      expect(text).not.toContain(health.id);
    });

    it("refuses on the database before it asks about the links", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      await setGrant(project, files.id, "none");
      await setGrant(project, health.id, "write");
      // The Files database is a non-sensitive system database, always open, so the links decide.
      await check(project, file, "write");
      const userDatabase = await inTenant(() => cp.createDatabase({ name: "Closed" }));
      await setGrant(project, userDatabase.id, "none");
      await expect(
        inTransaction((client) =>
          assertAgentDatabaseAccess(client, {
            agentProjectItemId: project,
            databaseId: userDatabase.id,
            access: "read",
            itemId: file.id,
          }),
        ),
      ).rejects.toMatchObject({ details: { resource: "database", databaseId: userDatabase.id } });
    });

    it("applies to an agent's project only: an external client is decided by the database", async () => {
      const file = await newFile();
      await link(fileToHealth, file, await newRecord());
      await inTransaction((client) =>
        assertReaderDatabaseAccess(client, { externalClient: true }, files.id, "read", undefined, file.id),
      );
    });

    it("locks the decision rows of the linked databases so a revoke waits for the transaction that passed the check", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      await setGrant(project, health.id, "read");
      let revoked = false;
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let passed: () => void = () => undefined;
      const checked = new Promise<void>((resolve) => {
        passed = resolve;
      });
      const reader = inTransaction(async (client) => {
        await check(project, file, "read", client);
        passed();
        await hold;
        expect(revoked).toBe(false);
      });
      await checked;
      const revoke = setGrant(project, health.id, "none").then(() => {
        revoked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(revoked).toBe(false);
      release();
      await reader;
      await revoke;
      expect(revoked).toBe(true);
      await expect(check(project, file, "read")).rejects.toMatchObject(FORBIDDEN);
    });

    describe("with a per-turn read allowance (issue #1849)", () => {
      async function runOf(project: string): Promise<string> {
        const run = await inTenant(() =>
          createAgentRun(dataPool, { projectItemId: project, triggeredBy: "user", task: "attached" }),
        );
        return run.id;
      }

      it("opens a read of the attached linked file and nothing else", async () => {
        const [project, attached, other] = [await newProject(), await newFile("Attached"), await newFile("Other")];
        await link(fileToHealth, attached, await newRecord());
        await link(fileToHealth, other, await newRecord());
        const runId = await runOf(project);
        await inTransaction((client) => allowItemsForTurn(client, runId, [attached.id]));

        const read = (file: ItemRow, access: "read" | "write") =>
          inTransaction((client) =>
            assertAgentDatabaseAccess(client, {
              agentProjectItemId: project,
              databaseId: file.databaseId,
              access,
              itemId: file.id,
              readAllowance: { agentRunId: runId, itemId: file.id },
            }),
          );
        await read(attached, "read");
        await expect(read(attached, "write")).rejects.toMatchObject(FORBIDDEN);
        await expect(read(other, "read")).rejects.toMatchObject(FORBIDDEN);
        expect((await inTenant(() => cp.findItem(attached.id, undefined, project, runId)))?.id).toBe(attached.id);
        await expect(inTenant(() => cp.findItem(other.id, undefined, project, runId))).rejects.toMatchObject(FORBIDDEN);
      });
    });
  });

  describe("single-item reads", () => {
    it("refuses item.get of a linked file without a grant on Health records, reads it with a read grant and leaves a human read unchanged", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      await expect(inTenant(() => cp.findItem(file.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => cp.getItem(files.id, file.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(file.id)))?.id).toBe(file.id);
      expect((await inTenant(() => cp.getItem(files.id, file.id)))?.id).toBe(file.id);

      await setGrant(project, health.id, "read");
      expect((await inTenant(() => cp.findItem(file.id, undefined, project)))?.id).toBe(file.id);
      expect((await inTenant(() => cp.getItem(files.id, file.id, undefined, project)))?.id).toBe(file.id);
    });

    it("reads the same file without a grant when it is not linked, and again after the edge is removed", async () => {
      const [project, free, file] = [await newProject(), await newFile("Free"), await newFile("Linked")];
      expect((await inTenant(() => cp.findItem(free.id, undefined, project)))?.id).toBe(free.id);
      const edge = await link(fileToHealth, file, await newRecord());
      await expect(inTenant(() => cp.findItem(file.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      await unlink(edge);
      expect((await inTenant(() => cp.findItem(file.id, undefined, project)))?.id).toBe(file.id);
    });

    it("applies the same rules to a transcript and to an Inbox entry, and reads a transcript about health without a link", async () => {
      const [project, transcript, entry, unlinked] = [
        await newProject(),
        await newTranscript("Doctor visit"),
        await newInboxEntry("Doctor visit"),
        await newTranscript("Doctor visit, no link"),
      ];
      await link(transcriptToHealth, transcript, await newRecord());
      await link(inboxToHealth, entry, await newRecord());
      for (const item of [transcript, entry]) {
        await expect(inTenant(() => cp.findItem(item.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      }
      expect((await inTenant(() => cp.findItem(unlinked.id, undefined, project)))?.id).toBe(unlinked.id);
      await setGrant(project, health.id, "read");
      for (const item of [transcript, entry]) {
        expect((await inTenant(() => cp.findItem(item.id, undefined, project)))?.id).toBe(item.id);
      }
    });

    it("refuses the relation list of a linked file and lists it with a read grant", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      await expect(inTenant(() => cp.listItemRelations(file.id, undefined, project))).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      const listed = await inTenant(() => cp.listItemRelations(file.id, undefined, project));
      expect(listed).toHaveLength(1);
    });
  });

  describe("lists and queries", () => {
    it("leaves the linked file out of item lists and database.query for an agent and keeps the unlinked files", async () => {
      const project = await newProject();
      const [linked, free] = [await newFile("Linked"), await newFile("Free")];
      await link(fileToHealth, linked, await newRecord());

      const listed = await inTenant(() => cp.listItems(files.id, { reader: project, limit: 200 }));
      expect(ids(listed)).toContain(free.id);
      expect(ids(listed)).not.toContain(linked.id);
      const queried = await inTenant(() => cp.queryDatabaseItems(files.id, { limit: 200 }, undefined, project));
      expect(ids(queried)).toContain(free.id);
      expect(ids(queried)).not.toContain(linked.id);

      const human = await inTenant(() => cp.queryDatabaseItems(files.id, { limit: 200 }));
      expect(ids(human)).toEqual(expect.arrayContaining([free.id, linked.id]));
      expect(ids(await inTenant(() => cp.listItems(files.id, { limit: 200 })))).toContain(linked.id);

      await setGrant(project, health.id, "read");
      expect(ids(await inTenant(() => cp.listItems(files.id, { reader: project, limit: 200 })))).toContain(linked.id);
      expect(ids(await inTenant(() => cp.queryDatabaseItems(files.id, { limit: 200 }, undefined, project)))).toContain(
        linked.id,
      );
    });

    it("keeps the filter of a request and the exclusion together", async () => {
      const project = await newProject();
      const [linked, free, other] = [
        await newFile("Needle linked"),
        await newFile("Needle free"),
        await newFile("Hay"),
      ];
      await link(fileToHealth, linked, await newRecord());
      const filter = { type: "contains", property: "name", value: "Needle" };
      const queried = await inTenant(() =>
        cp.queryDatabaseItems(files.id, { filter, includeCount: true }, undefined, project),
      );
      expect(ids(queried)).toEqual([free.id]);
      expect(queried.totalCount).toBe(1);
      expect(ids(queried)).not.toContain(other.id);
      const listed = await inTenant(() => cp.listItems(files.id, { reader: project, filter }));
      expect(ids(listed)).toEqual([free.id]);
    });

    it("keeps totalCount, pages and the cursor to the rows the agent may read", async () => {
      const project = await newProject();
      const sorted = [
        await newFile("Page a"),
        await newFile("Page b"),
        await newFile("Page c"),
        await newFile("Page d"),
      ];
      const filter = { type: "starts_with", property: "name", value: "Page " };
      await link(fileToHealth, sorted[1]!, await newRecord());
      await link(fileToHealth, sorted[2]!, await newRecord());
      const sort = [{ property: "name", direction: "asc" }];

      const first = await inTenant(() =>
        cp.queryDatabaseItems(files.id, { filter, sort, limit: 1, includeCount: true }, undefined, project),
      );
      expect(ids(first)).toEqual([sorted[0]!.id]);
      expect(first.totalCount).toBe(2);
      const second = await inTenant(() =>
        cp.queryDatabaseItems(
          files.id,
          { filter, sort, limit: 1, cursor: first.nextCursor ?? undefined, includeCount: true },
          undefined,
          project,
        ),
      );
      expect(ids(second)).toEqual([sorted[3]!.id]);
      expect(second.totalCount).toBe(2);
      expect(second.nextCursor).toBeNull();

      const human = await inTenant(() => cp.queryDatabaseItems(files.id, { filter, includeCount: true }));
      expect(human.totalCount).toBe(4);
    });

    it("leaves a linked transcript and a linked Inbox entry out of their databases for an agent", async () => {
      const project = await newProject();
      const [transcript, freeTranscript, entry, freeEntry] = [
        await newTranscript(),
        await newTranscript("Free"),
        await newInboxEntry(),
        await newInboxEntry("Free"),
      ];
      await link(transcriptToHealth, transcript, await newRecord());
      await link(inboxToHealth, entry, await newRecord());
      const transcriptPage = await inTenant(() =>
        cp.queryDatabaseItems(transcripts.id, { limit: 200 }, undefined, project),
      );
      expect(ids(transcriptPage)).toContain(freeTranscript.id);
      expect(ids(transcriptPage)).not.toContain(transcript.id);
      const inboxPage = await inTenant(() => cp.listItems(inbox.id, { reader: project, limit: 200 }));
      expect(ids(inboxPage)).toContain(freeEntry.id);
      expect(ids(inboxPage)).not.toContain(entry.id);
    });

    it("leaves a linked file out of view.query of a filtered view, with its count", async () => {
      const project = await newProject();
      const [linked, free] = [await newFile("View linked"), await newFile("View free")];
      await link(fileToHealth, linked, await newRecord());
      const view = await inTenant(() =>
        cp.createView({
          databaseId: files.id,
          type: "table",
          name: "View files",
          config: { filter: { type: "starts_with", property: "name", value: "View " } },
        }),
      );
      const forAgent = await inTenant(() =>
        cp.queryViewItems(view.id, { limit: 200, includeCount: true }, undefined, project),
      );
      expect(ids(forAgent)).toContain(free.id);
      expect(ids(forAgent)).not.toContain(linked.id);
      const human = await inTenant(() => cp.queryViewItems(view.id, { limit: 200, includeCount: true }));
      expect(ids(human)).toContain(linked.id);
      expect(forAgent.totalCount).toBe(1);
      expect(human.totalCount).toBe(2);
    });

    it("leaves a linked file out of a curated view's page, cursor and count, live and in the trash", async () => {
      const project = await newProject();
      const open = await inTenant(() => cp.createItem({ databaseId: attachments.id, properties: { name: "Open" } }));
      const members = [await newFile("Curated 0"), await newFile("Curated 1"), await newFile("Curated 2")];
      const [first, hidden, last] = members as [ItemRow, ItemRow, ItemRow];
      await link(fileToHealth, hidden, await newRecord());
      const curated = await inTenant(() =>
        cp.createView({ type: "list", name: "Mixed", config: { membership: "manual" } }),
      );
      for (const member of [first, hidden, open, last]) {
        await inTenant(() => cp.addViewItem({ viewId: curated.id, itemId: member.id, actor: { type: "user" } }));
      }
      const readable = [first.id, open.id, last.id];

      const page = await inTenant(() =>
        cp.queryViewItems(curated.id, { limit: 1, includeCount: true }, undefined, project),
      );
      expect(ids(page)).toEqual([first.id]);
      expect(page.totalCount).toBe(3);
      const second = await inTenant(() =>
        cp.queryViewItems(curated.id, { limit: 2, cursor: page.nextCursor ?? undefined }, undefined, project),
      );
      expect(ids(second)).toEqual([open.id, last.id]);
      expect(second.nextCursor).toBeNull();
      expect(ids(await inTenant(() => cp.queryViewItems(curated.id, {}, undefined, project)))).toEqual(readable);

      await inTenant(() => cp.softDeleteItem(files.id, last.id));
      const trashed = await inTenant(() =>
        cp.queryViewItems(curated.id, { inTrash: true, includeCount: true }, undefined, project),
      );
      expect(ids(trashed)).toEqual([first.id, open.id, last.id]);
      expect(trashed.totalCount).toBe(3);

      const human = await inTenant(() => cp.queryViewItems(curated.id, { includeCount: true }));
      expect(ids(human)).toEqual([first.id, hidden.id, open.id]);
      await setGrant(project, health.id, "read");
      const granted = await inTenant(() => cp.queryViewItems(curated.id, {}, undefined, project));
      expect(ids(granted)).toEqual([first.id, hidden.id, open.id]);
    });
  });

  describe("relation targets", () => {
    const expansion: RelationExpansionOptions = {
      relations: true,
      resolver: {
        resolve: () => ({
          icon: null,
          color: null,
          overviewOrder: null,
          switcherOrder: null,
          clientVisible: true,
          overviewHidden: false,
        }),
        collectionFilter: () => undefined,
        overviewHideable: () => false,
      },
    };

    async function attachmentWith(...fileItems: ItemRow[]): Promise<ItemRow> {
      const attachment = await inTenant(() =>
        cp.createItem({ databaseId: attachments.id, properties: { name: "Holder" } }),
      );
      for (const file of fileItems) await link(attachmentToFile, attachment, file);
      return attachment;
    }

    function targetsOf(item: ItemRow | null | undefined): unknown[] {
      const relations: unknown = Reflect.get(Object(item), "relations");
      const files = Reflect.get(Object(relations), "files");
      return Array.isArray(files) ? files : [];
    }

    it("returns a linked file the project may not read as an id and nothing else, and in full with a read grant", async () => {
      const [project, linked, free] = [await newProject(), await newFile("Hidden title"), await newFile("Shown title")];
      await link(fileToHealth, linked, await newRecord());
      const holder = await attachmentWith(linked, free);

      const forAgent = await inTenant(() => cp.findItem(holder.id, expansion, project));
      const targets = targetsOf(forAgent);
      expect(targets).toHaveLength(2);
      expect(targets).toContainEqual({ id: linked.id, hidden: true });
      expect(targets).toContainEqual(expect.objectContaining({ id: free.id, title: "Shown title" }));
      expect(JSON.stringify(forAgent)).not.toContain("Hidden title");

      const forHuman = await inTenant(() => cp.findItem(holder.id, expansion));
      expect(JSON.stringify(forHuman)).toContain("Hidden title");

      await setGrant(project, health.id, "read");
      const granted = await inTenant(() => cp.findItem(holder.id, expansion, project));
      expect(targetsOf(granted)).toContainEqual(expect.objectContaining({ id: linked.id, title: "Hidden title" }));
    });

    it("hides the linked file inside a projected relation property and in a query's expansion", async () => {
      const [project, linked] = [await newProject(), await newFile("Nested hidden")];
      await link(fileToHealth, linked, await newRecord());
      const holder = await attachmentWith(linked);
      const outer = await inTenant(() => cp.createItem({ databaseId: attachments.id, properties: { name: "Outer" } }));
      const toHolder = await inTenant(() =>
        cp.createRelationProperty({
          sourceDatabaseId: attachments.id,
          key: "holders",
          name: "Holders",
          targetDatabaseId: attachments.id,
        }),
      );
      await link(toHolder.property, outer, holder);

      const projection: RelationExpansionOptions = { ...expansion, relations: { holders: ["files"] } };
      const nested = await inTenant(() => cp.findItem(outer.id, projection, project));
      expect(JSON.stringify(nested)).toContain(JSON.stringify({ id: linked.id, hidden: true }));
      expect(JSON.stringify(nested)).not.toContain("Nested hidden");

      const queried = await inTenant(() => cp.queryDatabaseItems(attachments.id, { limit: 200 }, expansion, project));
      const holderRow = queried.items.find((item) => item.id === holder.id);
      expect(targetsOf(holderRow)).toEqual([{ id: linked.id, hidden: true }]);
    });

    it("lists an edge to a linked file as a hidden entry and in full with a read grant", async () => {
      const [project, linked, free] = [await newProject(), await newFile("Edge hidden"), await newFile("Edge shown")];
      await link(fileToHealth, linked, await newRecord());
      const holder = await attachmentWith(linked, free);
      const forAgent = await inTenant(() => cp.listItemRelations(holder.id, undefined, project));
      expect(forAgent).toContainEqual({
        relationPropertyId: attachmentToFile.id,
        propertyKey: "files",
        targetItemId: linked.id,
        hidden: true,
      });
      expect(forAgent).toContainEqual(expect.objectContaining({ targetItemId: free.id, targetDatabaseId: files.id }));
      expect(JSON.stringify((forAgent ?? []).filter((entry) => Reflect.get(entry, "hidden") === true))).not.toContain(
        files.id,
      );

      await setGrant(project, health.id, "read");
      const granted = await inTenant(() => cp.listItemRelations(holder.id, undefined, project));
      expect(granted).toContainEqual(expect.objectContaining({ targetItemId: linked.id, targetDatabaseId: files.id }));
      const human = await inTenant(() => cp.listItemRelations(holder.id));
      expect(human).toContainEqual(expect.objectContaining({ targetItemId: linked.id, targetDatabaseId: files.id }));
    });

    it("does not hide a linked file from an external client, which is decided by the database alone", async () => {
      const [linked] = [await newFile("External sees")];
      await link(fileToHealth, linked, await newRecord());
      const holder = await attachmentWith(linked);
      const seen = await inTenant(() => cp.findItem(holder.id, expansion, { externalClient: true }));
      expect(targetsOf(seen)).toContainEqual(expect.objectContaining({ id: linked.id, title: "External sees" }));
    });
  });

  describe("writes", () => {
    const patch = (project: string, file: ItemRow, name = "Renamed") =>
      inTenant(() =>
        cp.updateItem(
          { databaseId: files.id, itemId: file.id, propertiesPatch: { name } },
          undefined,
          undefined,
          agent(project),
        ),
      );

    it("lets an agent patch a linked file only with a write grant on the record's database and leaves it unchanged when refused", async () => {
      const [project, file] = [await newProject(), await newFile("Before")];
      await link(fileToHealth, file, await newRecord());
      await expect(patch(project, file)).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      await expect(patch(project, file)).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(file.id)))?.properties.name).toBe("Before");

      await setGrant(project, health.id, "write");
      await patch(project, file);
      expect((await inTenant(() => cp.findItem(file.id)))?.properties.name).toBe("Renamed");
    });

    it("patches an unlinked file for an agent without any grant, and a linked one for a human", async () => {
      const [project, free, linked] = [await newProject(), await newFile("Free"), await newFile("Linked")];
      await link(fileToHealth, linked, await newRecord());
      await patch(project, free);
      expect((await inTenant(() => cp.findItem(free.id)))?.properties.name).toBe("Renamed");
      await inTenant(() =>
        cp.updateItem({ databaseId: files.id, itemId: linked.id, propertiesPatch: { name: "By human" } }),
      );
      expect((await inTenant(() => cp.findItem(linked.id)))?.properties.name).toBe("By human");
    });

    it("lets an agent delete and restore a linked file only with a write grant, and writes nothing when refused", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      const remove = () => inTenant(() => cp.softDeleteItem(files.id, file.id, undefined, agent(project)));
      const restore = () => inTenant(() => cp.restoreItem(files.id, file.id, undefined, agent(project)));
      await expect(remove()).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItem(file.id)))?.deletedAt ?? null).toBeNull();

      await setGrant(project, health.id, "write");
      await remove();
      expect((await inTenant(() => cp.findItemIncludingDeleted(file.id)))?.deletedAt).not.toBeNull();

      await setGrant(project, health.id, "read");
      await expect(restore()).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => cp.findItemIncludingDeleted(file.id)))?.deletedAt).not.toBeNull();

      await setGrant(project, health.id, "write");
      await restore();
      expect((await inTenant(() => cp.findItem(file.id)))?.id).toBe(file.id);
    });

    it("refuses the projection of a delete of a linked file at request time and projects it with a write grant", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      const project_ = () =>
        inTransaction((client) =>
          computeDestructiveResourceProjection(client, {
            operation: "item.delete",
            input: { itemId: file.id },
            agentProjectItemId: project,
          }),
        );
      await expect(project_()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "write");
      expect((await project_()).snapshot.resourceId).toBe(file.id);
    });

    it("refuses the projection of a link.unlink of a linked file at request time and projects it with a write grant", async () => {
      const [project, file, source] = [await newProject(), await newFile("Linked"), await newFile("Source")];
      await link(fileToHealth, file, await newRecord());
      await inTransaction((client) =>
        insertValueLink(client, {
          itemId: file.id,
          propertyKey: "name",
          ruleKey: "test",
          sources: [{ kind: "item", sourceItemId: source.id, sourcePropertyKey: "name" }],
        }),
      );
      const projectUnlink = () =>
        inTransaction((client) =>
          computeDestructiveResourceProjection(client, {
            operation: "link.unlink",
            input: { itemId: file.id, propertyKey: "name" },
            agentProjectItemId: project,
          }),
        );
      await expect(projectUnlink()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "read");
      await expect(projectUnlink()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "write");
      const projection = await projectUnlink();
      expect(projection.snapshot.resourceId).toBe(file.id);
      expect(projection.valueLinks?.links).toMatchObject([{ itemId: file.id, propertyKey: "name" }]);
    });

    it("checks the links of a file before an agent unlinks a value of it, and passes the check with a write grant", async () => {
      const [project, file] = [await newProject(), await newFile()];
      await link(fileToHealth, file, await newRecord());
      const unlinkName = () => inTenant(() => cp.unlinkValue({ itemId: file.id, propertyKey: "name" }, agent(project)));
      await expect(unlinkName()).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "write");
      // The file has no value link on `name`, so the operation stops after the access check with a conflict.
      await expect(unlinkName()).rejects.toMatchObject({ status: 409, code: "value_link_conflict" });
    });
  });

  describe("page operations of a linked item", () => {
    const pageAccess = (reader: string | undefined, itemId: string, access: "read" | "write") =>
      inTransaction((client) => assertAgentPageAccess(client, reader, itemId, access));
    const subpageOf = async (parentItemId: string): Promise<string> => {
      const output = await inTransaction((client) =>
        createSubpageWithClient(client, { parent: { itemId: parentItemId }, title: "Sub" }, "user"),
      );
      const page = output.pages[0];
      if (!page) throw new Error("Missing subpage");
      return page.pageItemId;
    };

    it("closes the page of a linked file, of its subpage and of a linked transcript and Inbox entry to a project without the access", async () => {
      const project = await newProject();
      const file = await newFile();
      await link(fileToHealth, file, await newRecord());
      const subpage = await subpageOf(file.id);
      const transcript = await newTranscript();
      await link(transcriptToHealth, transcript, await newRecord());
      const entry = await newInboxEntry();
      await link(inboxToHealth, entry, await newRecord());

      for (const itemId of [file.id, subpage, transcript.id, entry.id]) {
        for (const access of ["read", "write"] as const) {
          await expect(pageAccess(project, itemId, access), `${access} ${itemId}`).rejects.toMatchObject(FORBIDDEN);
        }
      }
      await setGrant(project, health.id, "read");
      for (const itemId of [file.id, subpage, transcript.id, entry.id]) {
        await pageAccess(project, itemId, "read");
        await expect(pageAccess(project, itemId, "write"), `write ${itemId}`).rejects.toMatchObject(FORBIDDEN);
      }
      await setGrant(project, health.id, "write");
      for (const itemId of [file.id, subpage, transcript.id, entry.id]) {
        await pageAccess(project, itemId, "write");
      }
    });

    it("leaves the page of an unlinked file and of its subpage open, and the page of a linked one open to a person, to an external client and again after the edge is removed", async () => {
      const [project, free, linked] = [await newProject(), await newFile("Open"), await newFile("Linked")];
      const edge = await link(fileToHealth, linked, await newRecord());
      const freeSubpage = await subpageOf(free.id);
      for (const itemId of [free.id, freeSubpage]) {
        await pageAccess(project, itemId, "read");
        await pageAccess(project, itemId, "write");
      }
      // A person and the system carry no reader; an external client is decided by the database alone.
      await pageAccess(undefined, linked.id, "write");
      await inTransaction((client) => assertAgentPageAccess(client, { externalClient: true }, linked.id, "write"));

      await expect(pageAccess(project, linked.id, "read")).rejects.toMatchObject(FORBIDDEN);
      await unlink(edge);
      await pageAccess(project, linked.id, "write");
    });

    it("refuses every page read and write of a linked file through the document store and changes nothing", async () => {
      const docStore = createDocStore(dataPool);
      const [project, file] = [await newProject(), await newFile("Linked page")];
      await inTenant(() =>
        docStore.insertPageMarkdown(file.id, { placement: "end", markdown: "Private notes", origin: "user" }),
      );
      await link(fileToHealth, file, await newRecord());
      const before = await inTenant(() => docStore.readPageMarkdown(file.id));

      await expect(inTenant(() => docStore.readPageMarkdown(file.id, project))).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => docStore.getPageSummary(file.id, "en", undefined, project))).rejects.toMatchObject(
        FORBIDDEN,
      );
      await expect(
        inTenant(() => docStore.listPageChanges(file.id, { since: new Date(0), by: "user", limit: 10 }, project)),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(inTenant(() => docStore.ensurePage(file.id, project))).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTenant(() =>
          docStore.insertPageMarkdown(file.id, { placement: "end", markdown: "Injected", origin: "ai_agent" }, project),
        ),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inTenant(() => docStore.createSubpage({ parent: { itemId: file.id }, title: "Sub" }, "ai_agent", project)),
      ).rejects.toMatchObject(FORBIDDEN);
      expect((await inTenant(() => docStore.readPageMarkdown(file.id))).etag).toBe(before.etag);

      await setGrant(project, health.id, "read");
      expect((await inTenant(() => docStore.readPageMarkdown(file.id, project))).markdown).toContain("Private notes");
      await expect(
        inTenant(() =>
          docStore.insertPageMarkdown(file.id, { placement: "end", markdown: "Injected", origin: "ai_agent" }, project),
        ),
      ).rejects.toMatchObject(FORBIDDEN);
      await setGrant(project, health.id, "write");
      await inTenant(() =>
        docStore.insertPageMarkdown(file.id, { placement: "end", markdown: "Added", origin: "ai_agent" }, project),
      );
    });
  });

  describe("the Semp context of an attached item (issue #1849)", () => {
    let tasks: DatabaseRow;
    let taskToFiles: PropertyRow;

    beforeAll(async () => {
      tasks = await systemDatabase(TASKS_MODULE_ID);
      taskToFiles = await propertyOf(tasks, "files");
    });

    /** The `files` relation of a task as an agent's project reads it from the attached task's context. */
    async function attachedFiles(project: string | undefined, task: ItemRow) {
      const context = await inTransaction((client) =>
        readSempRefContext(
          client,
          { kind: "item", itemId: task.id, databaseId: tasks.id },
          project === undefined ? undefined : { agentProjectItemId: project },
        ),
      );
      const details = context?.details as { relations: Record<string, unknown> };
      return details.relations.files;
    }

    it("names an attached file only when it is not linked to a record the project may not read, and hides it otherwise", async () => {
      const project = await newProject();
      const task = await inTenant(() => cp.createItem({ databaseId: tasks.id, properties: { name: "Prepare visit" } }));
      const open = await newFile("agenda.pdf");
      const linked = await newFile("blood-test.pdf");
      await link(taskToFiles, task, open);
      await link(taskToFiles, task, linked);
      const edge = await link(fileToHealth, linked, await newRecord());

      expect(await attachedFiles(project, task)).toEqual({
        names: ["agenda.pdf"],
        truncated: false,
        hidden: [{ id: linked.id, hidden: true }],
      });
      // A person's context and a project that may read Health records name both files.
      expect(await attachedFiles(undefined, task)).toMatchObject({
        names: expect.arrayContaining(["agenda.pdf", "blood-test.pdf"]),
      });
      await setGrant(project, health.id, "read");
      expect(await attachedFiles(project, task)).toMatchObject({
        names: expect.arrayContaining(["agenda.pdf", "blood-test.pdf"]),
      });
      await setGrant(project, health.id, "none");
      await unlink(edge);
      expect(await attachedFiles(project, task)).toMatchObject({
        names: expect.arrayContaining(["agenda.pdf", "blood-test.pdf"]),
      });
    });
  });
});
