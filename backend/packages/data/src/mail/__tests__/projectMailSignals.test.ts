import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { withTransaction } from "../../db/pool.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createMoveFixtureMailbox,
  MOVE_FIXTURE_OWN_ADDRESS,
  type MoveFixtureMailbox,
  type MoveFolderKey,
} from "../../testSupport/mailThreadMoveFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import type { MailArrival } from "../mailArrival.js";
import type { MailEnvelopeAddress } from "../mailMessageMetaStore.js";
import { resolveMailModuleIds } from "../mailModuleIds.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";
import {
  createProjectMailSignalsApplyRouteHandler,
  createProjectMailSignalsPreviewRouteHandler,
  createProjectMailSignalsReadRouteHandler,
  createProjectMailSignalsReplaceRouteHandler,
} from "../projectMailSignalsRoutes.js";

const USER = { writerKind: "user" } as const;
const USER_ID = randomUUID();

const noopStorage: BlobStorageWriter = {
  async writeStream() {
    throw new Error("writeStream is not used by this test");
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

const signalsSchema = z
  .object({
    projectId: z.uuid(),
    domains: z.array(z.string()),
    addresses: z.array(z.string()),
    keywords: z.array(z.string()),
    updatedAt: z.string().nullable(),
    peopleAddresses: z.array(z.object({ personId: z.uuid(), name: z.string(), address: z.string() }).strict()),
  })
  .strict();

const previewSchema = z
  .object({
    total: z.number().int(),
    alreadyAssigned: z.number().int(),
    threads: z.array(
      z
        .object({
          threadId: z.uuid(),
          subject: z.string(),
          project: z.object({ id: z.uuid(), name: z.string() }).nullable(),
        })
        .loose(),
    ),
  })
  .strict();

const applySchema = z.object({ assigned: z.number().int(), skipped: z.number().int() }).strict();

interface World {
  tenant: string;
  mailbox: MoveFixtureMailbox;
  threadProjectPropertyId: string;
  projectPeoplePropertyId: string;
}

interface MessageInput {
  from?: string;
  to?: readonly string[];
  cc?: readonly string[];
  subject?: string;
  body?: string;
  day?: number;
  folder?: MoveFolderKey;
  arrival?: MailArrival;
}

interface Thread {
  threadId: string;
  threadItemId: string;
}

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let world: World;

const read = createProjectMailSignalsReadRouteHandler;
const replace = createProjectMailSignalsReplaceRouteHandler;
const preview = createProjectMailSignalsPreviewRouteHandler;
const apply = createProjectMailSignalsApplyRouteHandler;

function inTenant<T>(fn: () => Promise<T>, tenant = world.tenant): Promise<T> {
  return runInTenant(tenant, fn);
}

async function buildWorld(): Promise<World> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(runtime);
    const mailbox = await createMoveFixtureMailbox(runtime, {
      name: "Work",
      kind: "imap",
      ownAddress: MOVE_FIXTURE_OWN_ADDRESS,
    });
    const ids = await withTransaction(runtime, async (client) => {
      const threads = await getDatabaseByModuleId(client, "threads");
      const projects = await getDatabaseByModuleId(client, "projects");
      if (!threads || !projects) throw new Error("The Threads and Projects databases are not seeded");
      const threadProject = await getPropertyByKey(client, threads.id, "project");
      const projectPeople = await getPropertyByKey(client, projects.id, "people");
      if (!threadProject || !projectPeople) throw new Error("The relation properties are not seeded");
      return { threadProjectPropertyId: threadProject.id, projectPeoplePropertyId: projectPeople.id };
    });
    return { tenant, mailbox, ...ids };
  });
}

let messageCounter = 0;

async function ingest(input: MessageInput, target = world): Promise<Thread> {
  messageCounter += 1;
  const address = (value: string): MailEnvelopeAddress => ({ name: "", address: value });
  const folderItemId = target.mailbox.folders[input.folder ?? "inbox"];
  if (folderItemId === undefined) throw new Error("The mailbox lacks the folder");
  return inTenant(
    () =>
      withTransaction(runtime, async (client) => {
        const ids = await resolveMailModuleIds(client);
        const folder = await getPropertyByKey(client, ids.emailsDatabaseId, "folder");
        const attachments = await getPropertyByKey(client, ids.emailsDatabaseId, "attachments");
        if (!folder || !attachments) throw new Error("The Emails relations are not seeded");
        const result = await ingestEmailMessage(client, {
          arrival: input.arrival ?? "backfill",
          contentState: "full",
          emailsDatabaseId: ids.emailsDatabaseId,
          filesDatabaseId: ids.filesDatabaseId,
          folderRelationPropertyId: folder.id,
          attachmentsRelationPropertyId: attachments.id,
          mailboxItemId: target.mailbox.id,
          folderItemId,
          folderUid: messageCounter,
          messageId: `<signals-${messageCounter}-${randomUUID()}@example.test>`,
          subject: input.subject ?? "Hello",
          date: new Date(Date.UTC(2026, 9, input.day ?? 1, 9)),
          envelope: {
            from: address(input.from ?? "someone@example.test"),
            to: (input.to ?? [MOVE_FIXTURE_OWN_ADDRESS]).map(address),
            ...(input.cc ? { cc: input.cc.map(address) } : {}),
          },
          bodyText: input.body ?? "Nothing in particular.",
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "project-mail-signals",
        });
        const { rows } = await client.query<Record<string, unknown>>(
          "SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1",
          [result.itemId],
        );
        const row = z.object({ id: z.uuid(), item_id: z.uuid() }).parse(rows[0]);
        return { threadId: row.id, threadItemId: row.item_id };
      }),
    target.tenant,
  );
}

async function databaseIdOf(ownerModuleId: string, target = world): Promise<string> {
  const listed = await inTenant(() => cp.listDatabases(), target.tenant);
  const database = listed.find((entry) => entry.ownerModuleId === ownerModuleId);
  if (!database) throw new Error(`The ${ownerModuleId} database is not seeded`);
  return database.id;
}

async function createProject(name: string, target = world): Promise<string> {
  const databaseId = await databaseIdOf("projects", target);
  return (
    await inTenant(() => cp.createItem({ databaseId, properties: { name, status: "inProgress" } }), target.tenant)
  ).id;
}

async function addPerson(projectId: string, name: string, addresses: string[]): Promise<string> {
  const databaseId = await databaseIdOf("people");
  const person = (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
  await inTenant(() => withTransaction(runtime, (client) => reindexPersonEmails(client, person, addresses)));
  await inTenant(() =>
    cp.createRelation(
      { relationPropertyId: world.projectPeoplePropertyId, callerItemId: projectId, targetItemId: person },
      USER,
    ),
  );
  return person;
}

async function setProject(thread: Thread, projectId: string): Promise<void> {
  await inTenant(() =>
    cp.createRelation(
      { relationPropertyId: world.threadProjectPropertyId, callerItemId: thread.threadItemId, targetItemId: projectId },
      USER,
    ),
  );
}

async function projectOf(thread: Thread, target = world): Promise<string[]> {
  const edges = await inTenant(
    () => cp.listItemRelations(thread.threadItemId, target.threadProjectPropertyId),
    target.tenant,
  );
  return (edges ?? []).map((edge) => edge.targetItemId);
}

async function readSignals(projectId: string, target = world) {
  const answer = await inTenant(() => read(runtime)({ params: { projectId } }), target.tenant);
  return signalsSchema.parse(answer.body);
}

async function saveSignals(projectId: string, body: unknown, target = world) {
  const answer = await inTenant(() => replace(runtime)({ params: { projectId }, body }), target.tenant);
  return signalsSchema.parse(answer.body);
}

async function previewOf(projectId: string, body?: unknown, target = world) {
  const answer = await inTenant(() => preview(runtime)({ params: { projectId }, body }), target.tenant);
  return previewSchema.parse(answer.body);
}

async function applyTo(projectId: string, threadIds: unknown, target = world) {
  const answer = await inTenant(
    () => apply(runtime)({ params: { projectId }, body: { threadIds }, identity: { user: { id: USER_ID } } }),
    target.tenant,
  );
  return applySchema.parse(answer.body);
}

async function valueLinkCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM value_links");
  return rows[0]?.n ?? -1;
}

async function signalRowCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM project_mail_signals");
  return rows[0]?.n ?? -1;
}

function fieldOf(error: unknown): unknown {
  if (!(error instanceof ValidationError)) throw error;
  const details: unknown = error.details;
  return typeof details === "object" && details !== null && "field" in details ? details.field : undefined;
}

describe("project mail signals", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    world = await buildWorld();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("reading and replacing the signals", () => {
    it("answers a project without saved signals with empty lists", async () => {
      const project = await createProject("Website");
      expect(await readSignals(project)).toEqual({
        projectId: project,
        domains: [],
        addresses: [],
        keywords: [],
        updatedAt: null,
        peopleAddresses: [],
      });
    });

    it("stores the signals normalized and answers them with the people's addresses", async () => {
      const project = await createProject("Website");
      const jana = await addPerson(project, "Jana Nováková", ["jana@firma.test", "jana.novakova@home.test"]);

      const saved = await saveSignals(project, {
        domains: ["https://www.Acme.CZ/kontakt", "acme.cz", "Sub.Firma.test"],
        addresses: ["  Petr@Partner.TEST ", "petr@partner.test"],
        keywords: ["  Zálohová   faktura ", "zálohová faktura", "Smlouva"],
      });

      expect(saved).toMatchObject({
        projectId: project,
        domains: ["acme.cz", "sub.firma.test"],
        addresses: ["petr@partner.test"],
        keywords: ["Zálohová faktura", "Smlouva"],
        peopleAddresses: [
          { personId: jana, name: "Jana Nováková", address: "jana.novakova@home.test" },
          { personId: jana, name: "Jana Nováková", address: "jana@firma.test" },
        ],
      });
      expect(saved.updatedAt).not.toBeNull();
      expect(await readSignals(project)).toEqual(saved);
    });

    it("replaces the whole set, and a list left out becomes empty", async () => {
      const project = await createProject("Website");
      await saveSignals(project, { domains: ["acme.cz"], keywords: ["faktura"] });
      const saved = await saveSignals(project, { addresses: ["petr@partner.test"] });
      expect(saved).toMatchObject({ domains: [], addresses: ["petr@partner.test"], keywords: [] });
      expect(await signalRowCount()).toBe(1);
    });

    it.each([
      ["a body that is no object", null, "signals"],
      ["an unknown field", { people: [] }, "people"],
      ["domains that are no array", { domains: "acme.cz" }, "domains"],
      ["a host without a dot", { domains: ["localhost"] }, "domains"],
      ["a domain that is no host", { domains: ["not a host"] }, "domains"],
      ["more than 50 domains", { domains: Array.from({ length: 51 }, (_, i) => `d${i}.test`) }, "domains"],
      ["an address without an at sign", { addresses: ["petr.partner.test"] }, "addresses"],
      ["an address that is no string", { addresses: [42] }, "addresses"],
      ["more than 100 addresses", { addresses: Array.from({ length: 101 }, (_, i) => `a${i}@x.test`) }, "addresses"],
      ["a keyword without a word", { keywords: ["!!! ..."] }, "keywords"],
      ["a keyword over 100 characters", { keywords: ["a".repeat(101)] }, "keywords"],
      ["more than 50 keywords", { keywords: Array.from({ length: 51 }, (_, i) => `slovo${i}`) }, "keywords"],
    ])("refuses %s with a 400 naming the field and writes nothing", async (_name, body, field) => {
      const project = await createProject("Website");
      const failure = await saveSignals(project, body).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ValidationError);
      expect(fieldOf(failure)).toBe(field);
      expect(await signalRowCount()).toBe(0);
    });
  });

  describe("the preview", () => {
    it("lists the open threads the saved signals match, newest first, and counts the assigned ones", async () => {
      const project = await createProject("Website");
      const other = await createProject("Other");
      await saveSignals(project, {
        domains: ["acme.test"],
        addresses: ["petr@partner.test"],
        keywords: ["faktura"],
      });
      const byDomain = await ingest({ from: "jan@mail.acme.test", day: 1 });
      const byRecipient = await ingest({
        from: MOVE_FIXTURE_OWN_ADDRESS,
        to: ["petr@partner.test"],
        folder: "sent",
        day: 2,
      });
      const byCc = await ingest({ from: "x@elsewhere.test", cc: ["petr@partner.test"], day: 3 });
      const byKeyword = await ingest({ subject: "Posílám faktury za říjen", day: 4 });
      const assigned = await ingest({ from: "eva@acme.test", day: 5 });
      await setProject(assigned, other);
      await ingest({ from: "nobody@unrelated.test", subject: "Lunch?", day: 6 });
      await ingest({ from: "trash@acme.test", folder: "trash", day: 7 });
      await ingest({ from: "fake@notacme.test", day: 8 });

      const answer = await previewOf(project);

      expect(answer.total).toBe(4);
      expect(answer.alreadyAssigned).toBe(1);
      expect(answer.threads.map((row) => row.threadId)).toEqual(
        [byKeyword, byCc, byRecipient, byDomain].map((thread) => thread.threadId),
      );
      expect(answer.threads.every((row) => row.project === null)).toBe(true);
      expect(await projectOf(byDomain)).toEqual([]);
    });

    it("matches a draft instead of the saved signals, and refuses a malformed draft", async () => {
      const project = await createProject("Website");
      await saveSignals(project, { domains: ["acme.test"] });
      await ingest({ from: "jan@acme.test", subject: "Hello", day: 1 });
      const contract = await ingest({ from: "x@elsewhere.test", body: "Návrh smlouvy je v příloze.", day: 2 });

      const draft = await previewOf(project, { draft: { keywords: ["smlouva"] } });
      expect(draft.threads.map((row) => row.threadId)).toEqual([contract.threadId]);
      expect(draft.total).toBe(1);
      expect((await previewOf(project, {})).total).toBe(1);
      expect((await previewOf(project)).total).toBe(1);

      for (const [body, field] of [
        [{ draft: { domains: ["localhost"] } }, "domains"],
        [{ signals: {} }, "signals"],
        [[], "draft"],
      ] as const) {
        const failure = await previewOf(project, body).then(
          () => null,
          (error: unknown) => error,
        );
        expect(fieldOf(failure)).toBe(field);
      }
    });

    it("matches the addresses of the project's people without saved signals", async () => {
      const project = await createProject("Website");
      await addPerson(project, "Jana", ["jana@firma.test"]);
      const fromJana = await ingest({ from: "Jana@Firma.test", day: 1 });
      await ingest({ from: "petr@firma.test", day: 2 });
      const answer = await previewOf(project);
      expect(answer.threads.map((row) => row.threadId)).toEqual([fromJana.threadId]);
    });

    it("never counts a freemail domain, but an address at one, and never the tenant's own address", async () => {
      const project = await createProject("Website");
      await saveSignals(project, { domains: ["gmail.com", "seznam.cz"] });
      await ingest({ from: "anyone@gmail.com", day: 1 });
      await ingest({ from: "someone@seznam.cz", day: 2 });
      expect((await previewOf(project)).total).toBe(0);

      await saveSignals(project, { domains: ["gmail.com"], addresses: ["anyone@gmail.com", MOVE_FIXTURE_OWN_ADDRESS] });
      expect((await previewOf(project)).total).toBe(1);
    });

    it.each([
      ["faktura", "Posílám fakturu za září.", true],
      ["faktura", "Ve fakturách chybí IČO.", true],
      ["faktury", "Faktura je v příloze.", true],
      ["smlouva", "Podepsanou smlouvě nerozumím.", true],
      ["Novák", "Předejte to panu Novákovi.", true],
      ["Novák", "Volal pan Nováka?", true],
      ["zálohová faktura", "Posílám zálohovou fakturu.", true],
      ["zálohová faktura", "Faktura zálohová není.", false],
      ["faktura", "To je fakt.", false],
      ["ČEZ", "Vyúčtování od ČEZ.", true],
      ["ČEZ", "Cezava je řeka.", false],
    ])("matches the keyword %s in %j: %s", async (keyword, body, matches) => {
      const project = await createProject("Website");
      await saveSignals(project, { keywords: [keyword] });
      await ingest({ from: "x@elsewhere.test", subject: "Zpráva", body });
      expect((await previewOf(project)).total).toBe(matches ? 1 : 0);
    });
  });

  describe("the assignment", () => {
    it("gives only the listed threads that still match and have no project the project, as the user's own value", async () => {
      const project = await createProject("Website");
      const other = await createProject("Other");
      await saveSignals(project, { domains: ["acme.test"] });
      const first = await ingest({ from: "jan@acme.test", day: 1 });
      const second = await ingest({ from: "eva@acme.test", day: 2 });
      const assigned = await ingest({ from: "petr@acme.test", day: 3 });
      await setProject(assigned, other);
      const unrelated = await ingest({ from: "nobody@unrelated.test", day: 4 });

      const answer = await applyTo(project, [
        first.threadId,
        second.threadId,
        assigned.threadId,
        unrelated.threadId,
        randomUUID(),
        first.threadId,
      ]);

      expect(answer).toEqual({ assigned: 2, skipped: 3 });
      expect(await projectOf(first)).toEqual([project]);
      expect(await projectOf(second)).toEqual([project]);
      expect(await projectOf(assigned)).toEqual([other]);
      expect(await projectOf(unrelated)).toEqual([]);
      expect(await valueLinkCount()).toBe(0);

      expect(await applyTo(project, [first.threadId, second.threadId])).toEqual({ assigned: 0, skipped: 2 });
      expect((await previewOf(project)).alreadyAssigned).toBe(3);
    });

    it("matches the saved signals, so a thread matching only an unsaved draft is skipped", async () => {
      const project = await createProject("Website");
      const thread = await ingest({ from: "jan@acme.test" });
      expect((await previewOf(project, { draft: { domains: ["acme.test"] } })).total).toBe(1);
      expect(await applyTo(project, [thread.threadId])).toEqual({ assigned: 0, skipped: 1 });
      expect(await projectOf(thread)).toEqual([]);
    });

    it.each([
      ["no ids", []],
      ["an id that is no UUID", ["thread-1"]],
      ["more than 200 ids", Array.from({ length: 201 }, () => randomUUID())],
      ["no list", undefined],
    ])("refuses %s with a 400 naming threadIds", async (_name, threadIds) => {
      const project = await createProject("Website");
      const failure = await applyTo(project, threadIds).then(
        () => null,
        (error: unknown) => error,
      );
      expect(fieldOf(failure)).toBe("threadIds");
    });
  });

  describe("a project that is not the caller's", () => {
    async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
      return call().then(
        () => null,
        (error: unknown) => error,
      );
    }

    async function answersOf(projectId: string, threadId: string) {
      const outcomes = [
        await failureOf(() => readSignals(projectId)),
        await failureOf(() => saveSignals(projectId, { domains: ["acme.test"] })),
        await failureOf(() => previewOf(projectId)),
        await failureOf(() => previewOf(projectId, { draft: { domains: ["acme.test"] } })),
        await failureOf(() => applyTo(projectId, [threadId])),
      ];
      return outcomes.map((outcome) =>
        outcome instanceof NotFoundError ? { status: outcome.status, message: outcome.message } : outcome,
      );
    }

    it("answers another tenant's project and a trashed one exactly like a random id, and changes nothing", async () => {
      const foreignWorld = await buildWorld();
      const foreignProject = await createProject("Foreign", foreignWorld);
      await saveSignals(foreignProject, { domains: ["acme.test"] }, foreignWorld);
      const foreignThread = await ingest({ from: "jan@acme.test" }, foreignWorld);
      const trashed = await createProject("Trashed");
      await saveSignals(trashed, { domains: ["acme.test"] });
      await inTenant(async () => cp.softDeleteItem(await databaseIdOf("projects"), trashed));
      const ownThread = await ingest({ from: "jan@acme.test" });

      const random = await answersOf(randomUUID(), ownThread.threadId);
      expect(random).toEqual(Array.from({ length: 5 }, () => ({ status: 404, message: "Project not found" })));
      expect(await answersOf(foreignProject, ownThread.threadId)).toEqual(random);
      expect(await answersOf(trashed, ownThread.threadId)).toEqual(random);

      expect(await projectOf(ownThread)).toEqual([]);
      expect(await projectOf(foreignThread, foreignWorld)).toEqual([]);
      expect(await readSignals(foreignProject, foreignWorld)).toMatchObject({ domains: ["acme.test"] });
      expect((await previewOf(foreignProject, undefined, foreignWorld)).total).toBe(1);
      expect(await signalRowCount()).toBe(2);
    });
  });
});
