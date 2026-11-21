import "../../domainWriteHooks.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../../chokePoint/itemTrash.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../../chokePoint/valueLinkWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import type { ValueLinkEntry } from "../../chokePoint/valueLinkReads.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionQueueAffinity, createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  writeMailboxAddresses,
} from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import * as linkPropagation from "../../valueLinks/linkPropagation.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import { createMailThread, reassignThread } from "../mailMessageMetaStore.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";
import { loadResolverLinkRules } from "../../valueLinks/linkResolver.js";
import { evaluateResolverRule, relinkResolverLink } from "../../valueLinks/linkPropagation.js";
import { insertValueLink } from "../../chokePoint/valueLinksStore.js";
import {
  enqueueThreadLinkRulesForFirstInbound,
  firstInboundMessage,
  mailThreadIdOfItem,
  threadCompanyLinkResolver,
  threadProjectLinkResolver,
} from "../threadLinkRules.js";
import { planThreadValueMerge } from "../threadMergePrecedence.js";

const USER = { writerKind: "user" } as const;
const OWN_ADDRESS = "me@own.test";

const noopStorage: BlobStorageWriter = {
  async writeStream(_key, source) {
    const hash = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      byteSize += bytes.length;
    }
    return { byteSize, contentHash: hash.digest("hex") };
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

let admin: Pool;
let data: Pool;
let tenant: string;
let cp: ChokePoint;
const events: InvalidationEvent[] = [];

interface World {
  ids: Record<"emails" | "folders" | "files" | "mailboxes" | "people" | "companies" | "projects" | "threads", string>;
  props: Record<
    | "emailFolder"
    | "emailAttachments"
    | "folderMailbox"
    | "personCompanies"
    | "projectCompany"
    | "threadCompany"
    | "threadProject",
    string
  >;
  mailbox: string;
  inbox: string;
  sent: string;
}
let world: World;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant, fn);

const tx = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => inTenant(() => withTransaction(data, fn));

const query = <Row extends QueryResultRow>(text: string, values: unknown[]): Promise<QueryResult<Row>> =>
  inTenant(() => data.query<Row>(text, values));

/**
 * The choke point with every method run in the test tenant's scope, so a test body stays outside any scope and
 * can run the queue worker, which enters its own system scope.
 */
function scoped(target: ChokePoint): ChokePoint {
  return new Proxy(target, {
    get(object, name, receiver): unknown {
      const member: unknown = Reflect.get(object, name, receiver);
      return typeof member === "function"
        ? (...args: unknown[]) => inTenant(() => Reflect.apply(member, object, args) as Promise<unknown>)
        : member;
    },
  });
}

async function buildWorld(): Promise<World> {
  const databases = await cp.listDatabases();
  const id = (moduleId: string): string => {
    const found = databases.find((database) => database.ownerModuleId === moduleId);
    if (!found) throw new Error(`Missing ${moduleId}`);
    return found.id;
  };
  const ids = {
    emails: id("emails"),
    folders: id("folders"),
    files: id("files"),
    mailboxes: id("mailboxes"),
    people: id("people"),
    companies: id("companies"),
    projects: id("projects"),
    threads: id("threads"),
  };
  const prop = async (databaseId: string, key: string): Promise<string> => {
    const found = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
    if (!found) throw new Error(`Missing property ${key}`);
    return found.id;
  };
  const props = {
    emailFolder: await prop(ids.emails, "folder"),
    emailAttachments: await prop(ids.emails, "attachments"),
    folderMailbox: await prop(ids.folders, "mailbox"),
    personCompanies: await prop(ids.people, "companies"),
    projectCompany: await prop(ids.projects, "company"),
    threadCompany: await prop(ids.threads, "company"),
    threadProject: await prop(ids.threads, "project"),
  };
  const mailbox = await tx(async (client) => {
    const created = await createItemWithClient(client, {
      databaseId: ids.mailboxes,
      properties: { name: "Mailbox", provider: "generic" },
    });
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId: ids.mailboxes,
      mailboxItemId: created.id,
      address: OWN_ADDRESS,
    });
    return created.id;
  });
  const folder = (name: string, specialPurpose: string) =>
    tx(async (client) => {
      const created = await createItemWithClient(
        client,
        { databaseId: ids.folders, properties: { name, behavior: "folder", specialPurpose } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: props.folderMailbox, callerItemId: created.id, targetItemId: mailbox },
        { ownerProcess: "folders" },
      );
      return created.id;
    });
  return { ids, props, mailbox, inbox: await folder("INBOX", "inbox"), sent: await folder("Sent", "sent") };
}

const company = async (name: string, web?: string): Promise<string> =>
  (await cp.createItem({ databaseId: world.ids.companies, properties: { name, ...(web ? { web } : {}) } })).id;

async function project(name: string, ownerCompany: string | null, status = "inProgress"): Promise<string> {
  const created = await cp.createItem({ databaseId: world.ids.projects, properties: { name, status } });
  if (ownerCompany) await cp.createRelation(edge(world.props.projectCompany, created.id, ownerCompany), USER);
  return created.id;
}

async function person(name: string, address: string | null, companies: string[] = []): Promise<string> {
  const created = await cp.createItem({ databaseId: world.ids.people, properties: { name } });
  if (address) await tx((client) => reindexPersonEmails(client, created.id, [address]));
  for (const target of companies) await join(created.id, target);
  return created.id;
}

interface Ingested {
  messageItemId: string;
  threadItemId: string;
  threadId: string;
}

async function ingest(
  messageId: string,
  from: string,
  options: { folder?: "inbox" | "sent"; date?: string; inReplyTo?: string } = {},
): Promise<Ingested> {
  const result = await tx((client) =>
    ingestEmailMessage(client, {
      arrival: "live",
      contentState: "full",
      emailsDatabaseId: world.ids.emails,
      filesDatabaseId: world.ids.files,
      folderRelationPropertyId: world.props.emailFolder,
      attachmentsRelationPropertyId: world.props.emailAttachments,
      folderItemId: options.folder === "sent" ? world.sent : world.inbox,
      mailboxItemId: world.mailbox,
      messageId,
      inReplyTo: options.inReplyTo,
      subject: "Hello",
      envelope: { from: { address: from }, to: [{ address: "to@x.test" }] },
      bodyText: "hi",
      ...(options.date ? { date: new Date(options.date) } : {}),
      attachments: [],
      storage: noopStorage,
      storageKeyPrefix: "test",
    }),
  );
  const { rows } = await query<{ id: string; item_id: string }>(
    `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1`,
    [result.itemId],
  );
  const thread = rows[0];
  if (!thread) throw new Error("Expected the message to have a thread");
  return { messageItemId: result.itemId, threadItemId: thread.item_id, threadId: thread.id };
}

/**
 * Runs the queued propagation jobs, and the jobs they queue, through the registered worker task. One `runOnce` runs
 * one job of a tenant's lane, so it repeats until the queue holds none, and fails with the last error of a job that
 * could not run.
 */
async function pendingPropagationJobs(): Promise<Array<{ key: string; last_error: string | null }>> {
  const { rows } = await admin.query<{ key: string; last_error: string | null }>(
    `SELECT j.key, j.last_error FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1`,
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  return rows;
}

async function runPropagation(): Promise<void> {
  const handler = createCoreTaskList(data, createActionRegistry())[CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE];
  if (!handler) throw new Error("Propagation handler missing");
  const pending = pendingPropagationJobs;
  for (let round = 0; round < 60; round++) {
    if ((await pending()).length === 0) return;
    await runOnce({ pgPool: data, taskList: { [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: handler } });
  }
  throw new Error(`Propagation jobs left: ${JSON.stringify(await pending())}`);
}

type ValueKey = "company" | "project";
const relationOf = (key: ValueKey) => (key === "company" ? world.props.threadCompany : world.props.threadProject);
const edge = (relationPropertyId: string, callerItemId: string, targetItemId: string) => ({
  relationPropertyId,
  callerItemId,
  targetItemId,
});

async function valueOf(threadItemId: string, key: ValueKey): Promise<string[]> {
  return ((await cp.listItemRelations(threadItemId, relationOf(key))) ?? []).map((row) => row.targetItemId).sort();
}

/** Ingests a message and runs the propagation it queues. */
async function received(...args: Parameters<typeof ingest>): Promise<Ingested> {
  const result = await ingest(...args);
  await runPropagation();
  return result;
}

async function valuesOf(threadItemId: string): Promise<Record<ValueKey, string[]>> {
  return { company: await valueOf(threadItemId, "company"), project: await valueOf(threadItemId, "project") };
}

async function linkOf(threadItemId: string, key: ValueKey): Promise<ValueLinkEntry | undefined> {
  return (await cp.getValueLinksForItems([threadItemId])).get(threadItemId)?.[key];
}

async function linkRows(
  threadItemId: string,
): Promise<Array<{ property_key: string; rule_key: string; state: string }>> {
  const { rows } = await query<{ property_key: string; rule_key: string; state: string }>(
    "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key",
    [threadItemId],
  );
  return rows;
}

const setValue = (threadItemId: string, key: ValueKey, targetItemId: string) =>
  cp.createRelation(edge(relationOf(key), threadItemId, targetItemId), USER);
const clearValue = (threadItemId: string, key: ValueKey, targetItemId: string) =>
  cp.deleteRelation(edge(relationOf(key), threadItemId, targetItemId), USER);
const join = (personId: string, companyId: string) =>
  cp.createRelation(edge(world.props.personCompanies, personId, companyId), USER);
const leave = (personId: string, companyId: string) =>
  cp.deleteRelation(edge(world.props.personCompanies, personId, companyId), USER);
const setWeb = (companyId: string, web: string) =>
  cp.updateItem({ databaseId: world.ids.companies, itemId: companyId, propertiesPatch: { web } });
const setStatus = (projectId: string, status: string) =>
  cp.updateItem({ databaseId: world.ids.projects, itemId: projectId, propertiesPatch: { status } });
const mailThreadEvents = () => events.filter((event) => event.scope === "mailThread");
const enqueueSpy = () => vi.spyOn(linkPropagation, "enqueueLinkPropagation");
const NOTHING = { values: [], sources: [] };

/** Creates a company of the given web in a fresh other tenant. */
async function companyInOtherTenant(web: string): Promise<void> {
  await runInTenant(await createTestTenant(admin), async () => {
    await seedSystem(data);
    const otherCp = createChokePoint(data);
    const companies = (await otherCp.listDatabases()).find((database) => database.ownerModuleId === "companies");
    if (!companies) throw new Error("Missing companies");
    await otherCp.createItem({ databaseId: companies.id, properties: { name: "Other tenant's", web } });
  });
}

describe("the Threads company and project link rules", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check thread link rule role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(data));
    cp = scoped(createChokePoint(data));
    world = await inTenant(buildWorld);
    events.length = 0;
    setInvalidationHook((event) => events.push(event));
  });
  afterEach(() => {
    setInvalidationHook(() => {});
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await data?.end();
    await admin?.end();
  });

  describe("the company rule", () => {
    it("gives a thread from a known person the company of that person whose web host matches, and its single active project, both marked inherited, the person being the source of the company", async () => {
      const acme = await company("Acme", "https://www.acme.cz/about");
      const active = await project("Active", acme);
      const john = await person("John", "john@acme.cz", [acme]);
      const { threadItemId } = await received("<m1@acme>", "john@acme.cz");
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
      expect(await linkOf(threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: john, databaseKey: "people", propertyKey: "companies" }],
        brokenBy: null,
      });
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      expect(await linkOf(threadItemId, "project")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: acme, databaseKey: "companies", propertyKey: "projects" }],
        brokenBy: null,
      });
    });

    it("matches a subdomain of the company's host and ignores the case of the address and of the web value", async () => {
      const acme = await company("Acme", "https://WWW.Acme.CZ");
      await person("John", "john@mail.acme.cz", [acme]);
      const { threadItemId } = await received("<m1@acme>", "John@Mail.ACME.cz");
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
    });

    it("gives a thread from an unknown address of a company's domain that company, with the sender domain as its source", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
      expect(await linkOf(threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "acme.cz", propertyKey: "web" }],
      });
      const stored = await query<{ source_kind: string; source_item_id: string | null; domain: string | null }>(
        `SELECT s.source_kind, s.source_item_id, s.domain FROM value_link_sources s
           JOIN value_links l ON l.id = s.link_id WHERE l.item_id = $1`,
        [threadItemId],
      );
      expect(stored.rows).toEqual([{ source_kind: "senderDomain", source_item_id: null, domain: "acme.cz" }]);
    });

    it.each([
      {
        name: "a freemail address of a person in a company",
        from: "john@gmail.com",
        setup: async () => {
          const acme = await company("Acme", "https://acme.cz");
          await project("Active", acme);
          await person("John", "john@gmail.com", [acme]);
        },
      },
      {
        name: "a freemail domain, even for a company whose web is that domain",
        from: "someone@gmail.com",
        setup: async () => void (await company("Gmail fan club", "https://gmail.com")),
      },
      {
        // Only the companies of a known person are looked at.
        name: "a known person who is not in the company of the domain",
        from: "john@acme.cz",
        setup: async () => {
          await company("Acme", "https://acme.cz");
          await person("John", "john@acme.cz", [await company("Other", "https://other.cz")]);
        },
      },
      {
        name: "a known person of whose companies several match",
        from: "john@labs.acme.cz",
        setup: async () => {
          await person("John", "john@labs.acme.cz", [
            await company("Acme", "https://acme.cz"),
            await company("Acme Labs", "https://labs.acme.cz"),
          ]);
        },
      },
      {
        name: "an unknown sender whose domain several companies match",
        from: "sales@labs.acme.cz",
        setup: async () => {
          await company("Acme", "https://acme.cz");
          await company("Acme Labs", "https://labs.acme.cz");
        },
      },
      {
        name: "a domain no company matches",
        from: "someone@elsewhere.test",
        setup: async () => void (await company("Acme", "https://acme.cz")),
      },
    ])("gives $name no company and no project, and writes no link", async ({ from, setup }) => {
      await setup();
      const { threadItemId } = await received("<m1@x>", from);
      expect(await valuesOf(threadItemId)).toEqual({ company: [], project: [] });
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("takes the sender from the first inbound message, not from the user's own mail sent before it", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await company("Other", "https://other.cz");
      const own = await ingest("<own@x>", OWN_ADDRESS, { folder: "sent", date: "2026-01-01T10:00:00Z" });
      const first = await ingest("<m1@acme>", "sales@acme.cz", { inReplyTo: "<own@x>", date: "2026-01-02T10:00:00Z" });
      expect(first.threadId).toBe(own.threadId);
      await ingest("<m2@other>", "sales@other.cz", { inReplyTo: "<own@x>", date: "2026-01-03T10:00:00Z" });
      await runPropagation();
      expect(await valueOf(own.threadItemId, "company")).toEqual([acme]);
      expect(await tx((client) => firstInboundMessage(client, own.threadId))).toEqual({
        itemId: first.messageItemId,
        senderAddress: "sales@acme.cz",
      });
    });

    it("leaves a company the user chose before the first message of the thread was evaluated as the user's own", async () => {
      await company("Acme", "https://acme.cz");
      const chosen = await company("Chosen");
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await setValue(first.threadItemId, "company", chosen);
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([chosen]);
      expect(await linkRows(first.threadItemId)).toEqual([]);
    });

    it("follows the sender when the first inbound message changes: an earlier-dated message from another company replaces the company", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other", "https://other.cz");
      const first = await received("<m1@acme>", "sales@acme.cz", { date: "2026-01-05T10:00:00Z" });
      expect(await valueOf(first.threadItemId, "company")).toEqual([acme]);
      await ingest("<m0@other>", "sales@other.cz", { inReplyTo: "<m1@acme>", date: "2026-01-04T10:00:00Z" });
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([other]);
      expect(await linkOf(first.threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "other.cz" }],
      });
    });

    it("evaluates nothing for a new message that is not the first inbound one of its thread", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await company("Other", "https://other.cz");
      const first = await received("<m1@acme>", "sales@acme.cz", { date: "2026-01-01T10:00:00Z" });
      const spy = enqueueSpy();
      await ingest("<m2@other>", "sales@other.cz", { inReplyTo: "<m1@acme>", date: "2026-01-02T10:00:00Z" });
      await ingest("<m3@x>", OWN_ADDRESS, { folder: "sent", inReplyTo: "<m1@acme>", date: "2026-01-03T10:00:00Z" });
      expect(spy).not.toHaveBeenCalled();
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([acme]);
    });

    it("evaluates the company rule for the thread when the new message is its first inbound one, and nothing for an outgoing first message", async () => {
      await company("Acme", "https://acme.cz");
      const spy = enqueueSpy();
      await ingest("<own@x>", OWN_ADDRESS, { folder: "sent" });
      expect(spy).not.toHaveBeenCalled();
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      // The thread has no company and no project link yet: the project rule follows the company edge's write.
      expect(spy.mock.calls.map(([, ruleKey, itemId, hop]) => [ruleKey, itemId, hop])).toEqual([
        ["threadCompanyFromSender", first.threadItemId, 1],
      ]);
    });

    it("also evaluates the project rule at the first inbound message of a thread that already has a company", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const own = await ingest("<own@x>", OWN_ADDRESS, { folder: "sent" });
      await cp.createRelation(edge(world.props.threadCompany, own.threadItemId, acme), USER);
      const spy = enqueueSpy();
      const reply = await ingest("<m1@acme>", "sales@acme.cz", { inReplyTo: "<own@x>" });
      expect(reply.threadItemId).toBe(own.threadItemId);
      expect(spy.mock.calls.map(([, ruleKey, itemId, hop]) => [ruleKey, itemId, hop])).toEqual([
        ["threadCompanyFromSender", own.threadItemId, 1],
        ["threadProjectFromCompany", own.threadItemId, 1],
      ]);
    });

    it("queues nothing for a message that has no mail message row or a thread bound to no Threads item", async () => {
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      await tx((client) => client.query("UPDATE mail_threads SET item_id = NULL WHERE id = $1", [first.threadId]));
      const spy = enqueueSpy();
      await tx((client) => enqueueThreadLinkRulesForFirstInbound(client, randomUUID()));
      await tx((client) => enqueueThreadLinkRulesForFirstInbound(client, first.messageItemId));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("the project rule", () => {
    it.each(["inProgress", "longTerm"])(
      "gives the thread the single active (%s) project of its company, marked inherited with the company as its source",
      async (status) => {
        const acme = await company("Acme", "https://acme.cz");
        const active = await project("Active", acme, status);
        await project("Finished", acme, "done");
        await project("Archived", acme, "archived");
        const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
        expect(await valueOf(threadItemId, "project")).toEqual([active]);
        expect(await linkOf(threadItemId, "project")).toMatchObject({
          valueKind: "inherited",
          sources: [{ kind: "item", itemId: acme, databaseKey: "companies", propertyKey: "projects" }],
        });
      },
    );

    it("gives no project for a company without an active project or with several", async () => {
      const none = await company("None", "https://none.test");
      await project("Done", none, "done");
      const several = await company("Several", "https://several.test");
      await project("One", several, "inProgress");
      await project("Two", several, "longTerm");
      const first = await ingest("<m1@none>", "x@none.test");
      const second = await received("<m2@several>", "x@several.test");
      expect(await valuesOf(first.threadItemId)).toEqual({ company: [none], project: [] });
      expect(await valuesOf(second.threadItemId)).toEqual({ company: [several], project: [] });
      expect(await linkRows(first.threadItemId)).toEqual([
        { property_key: "company", rule_key: "threadCompanyFromSender", state: "on" },
      ]);
    });

    it("inherits from a company the user entered, as from an inherited one", async () => {
      const chosen = await company("Chosen");
      const active = await project("Active", chosen);
      const { threadItemId } = await received("<m1@x>", "someone@elsewhere.test");
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      await setValue(threadItemId, "company", chosen);
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      expect(await linkOf(threadItemId, "company")).toBeUndefined();
      expect(await linkOf(threadItemId, "project")).toMatchObject({ valueKind: "inherited" });
    });

    it("changes the thread's inherited project when the company's active project changes", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const first = await project("First", acme, "inProgress");
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "project")).toEqual([first]);
      const second = await project("Second", acme, "done");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([first]);
      await setStatus(first, "done");
      await setStatus(second, "inProgress");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([second]);
    });

    it("follows an edge change of the company's projects", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      const added = await project("Added", acme);
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([added]);
      await cp.deleteRelation(edge(world.props.projectCompany, added, acme), USER);
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      expect(await linkOf(threadItemId, "project")).toBeUndefined();
    });

    it("ends the project link when the user sets the project by hand, leaves it alone on a later change of the company's project, and restores it on relink", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const inherited = await project("Inherited", acme);
      const byHand = await project("By hand", null);
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "project")).toEqual([inherited]);

      await clearValue(threadItemId, "project", inherited);
      await setValue(threadItemId, "project", byHand);
      expect(await linkOf(threadItemId, "project")).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });

      const later = await project("Later", acme);
      await setStatus(inherited, "done");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([byHand]);
      expect(await linkOf(threadItemId, "project")).toMatchObject({ valueKind: "inheritedBroken" });

      expect(await cp.relinkValue({ itemId: threadItemId, propertyKey: "project" })).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: acme, propertyKey: "projects" }],
      });
      expect(await valueOf(threadItemId, "project")).toEqual([later]);
    });

    it("refuses to relink a project when the company has no single active project", async () => {
      const inherited = await project("Inherited", await company("Acme", "https://acme.cz"));
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      await clearValue(threadItemId, "project", inherited);
      await setStatus(inherited, "done");
      await expect(cp.relinkValue({ itemId: threadItemId, propertyKey: "project" })).rejects.toMatchObject({
        status: 409,
        code: "value_link_conflict",
      });
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      expect(await linkOf(threadItemId, "project")).toMatchObject({ valueKind: "inheritedBroken" });
    });

    it("clears the inherited project when the user sets no company on the thread, and the company link ends", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const active = await project("Active", acme);
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      await clearValue(threadItemId, "company", acme);
      await runPropagation();
      expect(await valuesOf(threadItemId)).toEqual({ company: [], project: [] });
      expect(await linkRows(threadItemId)).toEqual([
        { property_key: "company", rule_key: "threadCompanyFromSender", state: "broken" },
      ]);
    });

    it("keeps a project the user entered when the company is cleared", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const inherited = await project("Inherited", acme);
      const byHand = await project("By hand", null);
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      await clearValue(threadItemId, "project", inherited);
      await setValue(threadItemId, "project", byHand);
      await clearValue(threadItemId, "company", acme);
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([byHand]);
    });
  });

  describe("recomputation inputs", () => {
    it("takes the company away when its web no longer matches the sender's domain", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const active = await project("Active", acme);
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      await setWeb(acme, "https://moved.test");
      await runPropagation();
      expect(await valuesOf(threadItemId)).toEqual({ company: [], project: [] });
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it.each([
      {
        name: "a company's web starts to match",
        before: () => company("Acme"),
        after: async (acme: string | null) => {
          if (!acme) throw new Error("Missing company");
          await setWeb(acme, "https://acme.cz");
          return acme;
        },
      },
      {
        name: "a company is created with a matching web",
        before: async () => null,
        after: () => company("NewCo", "https://acme.cz"),
      },
      {
        name: "a company with a matching web is restored from the trash",
        before: async () => {
          const acme = await company("Acme", "https://acme.cz");
          await tx((client) =>
            itemDeleteWithClient(client, world.ids.companies, acme, { queueAffinity: createActionQueueAffinity() }),
          );
          return acme;
        },
        after: async (acme: string | null) => {
          if (!acme) throw new Error("Missing company");
          await tx((client) => restoreItemWithClient(client, world.ids.companies, acme, createActionQueueAffinity()));
          return acme;
        },
      },
    ])("gives an empty thread the company of its sender's domain when $name", async ({ before, after }) => {
      const initial = await before();
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      const matching = await after(initial);
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([matching]);
      expect(await linkOf(threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "acme.cz" }],
      });
    });

    it("queues nothing for a company created without a web, a created project or an item of a database no rule reads", async () => {
      await company("NoWeb");
      await project("Planned", null);
      await cp.createItem({ databaseId: world.ids.people, properties: { name: "Jane" } });
      expect(await pendingPropagationJobs()).toEqual([]);
    });

    it.each([
      { name: "one of them changes its web", secondWeb: "https://www.acme.cz", firstWeb: "https://other.test" },
      { name: "one of them clears its web", secondWeb: "https://acme.cz", firstWeb: "" },
      {
        name: "one of a known person's two changes its web",
        secondWeb: "https://acme.cz",
        firstWeb: "https://other.test",
        known: true,
      },
    ])(
      "gives the remaining company to a thread that matched two companies of one domain when $name",
      async ({ firstWeb, secondWeb, known }) => {
        const first = await company("First", "https://acme.cz");
        const second = await company("Second", secondWeb);
        const secondProject = await project("Second project", second);
        const from = known ? "john@acme.cz" : "sales@acme.cz";
        if (known) await person("John", from, [first, second]);
        const { threadItemId } = await received("<m1@acme>", from);
        expect(await valueOf(threadItemId, "company")).toEqual([]);
        await setWeb(first, firstWeb);
        await runPropagation();
        expect(await valuesOf(threadItemId)).toEqual({ company: [second], project: [secondProject] });
      },
    );

    it("gives the threads of a known person the company when the person joins it, and takes it away when the person leaves", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz");
      const { threadItemId } = await received("<m1@acme>", "john@acme.cz");
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await join(john, acme);
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
      await leave(john, acme);
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("does not touch a thread of another person or of a company the change does not concern", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other", "https://other.cz");
      const otherProject = await project("Other project", other);
      const john = await person("John", "john@acme.cz");
      await person("Jane", "jane@other.cz", [other]);
      const johns = await ingest("<m1@acme>", "john@acme.cz");
      const janes = await received("<m2@other>", "jane@other.cz");
      expect(await valueOf(janes.threadItemId, "company")).toEqual([other]);
      await join(john, acme);
      await runPropagation();
      expect(await valueOf(johns.threadItemId, "company")).toEqual([acme]);
      expect(await valuesOf(janes.threadItemId)).toEqual({ company: [other], project: [otherProject] });
    });
  });

  describe("resolvers read directly", () => {
    const resolveCompany = (threadItemId: string) =>
      tx((client) => threadCompanyLinkResolver.resolve(client, threadItemId));
    const affected = (
      resolver: typeof threadCompanyLinkResolver,
      changed: string,
      afterId: string | null = null,
      limit = 10,
    ) => tx((client) => resolver.affectedItemIds(client, changed, afterId, limit));

    it("gives no company for a thread without an inbound message, a sender without a domain or an item bound to no mail thread", async () => {
      await company("Acme", "https://acme.cz");
      const own = await ingest("<own@x>", OWN_ADDRESS, { folder: "sent" });
      expect(await resolveCompany(own.threadItemId)).toEqual(NOTHING);
      expect(await tx((client) => firstInboundMessage(client, own.threadId))).toBeNull();
      const odd = await ingest("<odd@x>", "no-domain");
      expect(await resolveCompany(odd.threadItemId)).toEqual(NOTHING);
      expect(await resolveCompany(randomUUID())).toEqual(NOTHING);
      expect(await tx((client) => mailThreadIdOfItem(client, randomUUID()))).toBeNull();
    });

    it("treats an address of a trashed person as an unknown sender", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz");
      const first = await ingest("<m1@acme>", "john@acme.cz");
      await cp.softDeleteItem(world.ids.people, john);
      expect(await resolveCompany(first.threadItemId)).toEqual({
        values: [acme],
        sources: [{ kind: "senderDomain", domain: "acme.cz", sourcePropertyKey: "web" }],
      });
    });

    it("gives no project for a thread whose company is in the trash", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await project("Active", acme);
      const first = await received("<m1@acme>", "sales@acme.cz");
      await cp.softDeleteItem(world.ids.companies, acme);
      expect(await tx((client) => threadProjectLinkResolver.resolve(client, first.threadItemId))).toEqual(NOTHING);
    });

    it("names no affected item for a changed item of another database, a missing item or a trashed one", async () => {
      const active = await project("Active", await company("Acme", "https://acme.cz"));
      const gone = await company("Gone");
      await cp.softDeleteItem(world.ids.companies, gone);
      for (const changed of [active, randomUUID(), gone])
        expect(await affected(threadCompanyLinkResolver, changed)).toEqual([]);
      for (const changed of [randomUUID(), gone, await person("John", null)])
        expect(await affected(threadProjectLinkResolver, changed)).toEqual([]);
    });

    it("names a thread itself for a change of that thread, only on the first page", async () => {
      const { threadItemId } = await ingest("<m1@x>", "x@elsewhere.test");
      for (const resolver of [threadCompanyLinkResolver, threadProjectLinkResolver]) {
        expect(await affected(resolver, threadItemId)).toEqual([threadItemId]);
        expect(await affected(resolver, threadItemId, threadItemId)).toEqual([]);
      }
    });

    it("pages the threads of a company in ascending id order", async () => {
      const chosen = await company("Chosen");
      const threads = [
        await ingest("<m1@x>", "a@elsewhere.test"),
        await ingest("<m2@x>", "b@elsewhere.test"),
        await ingest("<m3@x>", "c@elsewhere.test"),
      ];
      for (const thread of threads) await setValue(thread.threadItemId, "company", chosen);
      const ids = threads.map((thread) => thread.threadItemId).sort();
      const firstPage = await affected(threadProjectLinkResolver, chosen, null, 2);
      expect(firstPage).toEqual(ids.slice(0, 2));
      expect(await affected(threadProjectLinkResolver, chosen, firstPage[1] ?? null, 2)).toEqual(ids.slice(2));
    });

    it("names the threads of the companies of a project when its status changes, and none for a project without a company", async () => {
      const acme = await company("Acme");
      const owned = await project("Owned", acme);
      const orphan = await project("Orphan", null);
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      await setValue(first.threadItemId, "company", acme);
      expect(await affected(threadProjectLinkResolver, owned)).toEqual([first.threadItemId]);
      expect(await affected(threadProjectLinkResolver, orphan)).toEqual([]);
    });

    it("names the threads of a person by the person's addresses and by the links the person is the source of", async () => {
      const john = await person("John", "john@acme.cz", [await company("Acme", "https://acme.cz")]);
      const written = await received("<m1@acme>", "john@acme.cz");
      expect(await affected(threadCompanyLinkResolver, john)).toEqual([written.threadItemId]);
      // The person gives the address up: the thread is still named, through the link that has the person as its source.
      await tx((client) => reindexPersonEmails(client, john, []));
      expect(await affected(threadCompanyLinkResolver, john)).toEqual([written.threadItemId]);
      expect(await affected(threadCompanyLinkResolver, john, written.threadItemId)).toEqual([]);
    });

    it("names the threads without a company that were written from a domain of another company's host, for a change of a company", async () => {
      const first = await company("First", "https://acme.cz");
      await company("Second", "https://acme.cz");
      const ambiguous = await ingest("<m1@acme>", "sales@acme.cz");
      await ingest("<m2@x>", "sales@elsewhere.test");
      await runPropagation();
      expect(await affected(threadCompanyLinkResolver, first)).toEqual([ambiguous.threadItemId]);
    });

    it("names no thread of another company's host that already holds a company, for a change of a company", async () => {
      const first = await company("First", "https://other.test");
      await company("Second", "https://acme.cz");
      await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await affected(threadCompanyLinkResolver, first)).toEqual([]);
    });

    it("names no thread of a company whose web holds no host, and the threads that hold it", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const first = await received("<m1@acme>", "sales@acme.cz");
      await setWeb(acme, "");
      expect(await affected(threadCompanyLinkResolver, acme)).toEqual([first.threadItemId]);
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([]);
      expect(await linkRows(first.threadItemId)).toEqual([]);
    });
  });

  describe("the evaluation of one item", () => {
    const companyRule = async () => {
      const rule = (await loadResolverLinkRules()).find((entry) => entry.key === "threadCompanyFromSender");
      if (!rule) throw new Error("Missing company rule");
      return rule;
    };

    it("leaves a thread whose company link belongs to another rule as it is", async () => {
      await company("Acme", "https://acme.cz");
      const other = await company("Other");
      const first = await ingest("<m1@x>", "sales@acme.cz");
      await tx(async (client) => {
        await insertValueLink(client, {
          itemId: first.threadItemId,
          propertyKey: "company",
          ruleKey: "someOtherRule",
          sources: [{ kind: "senderDomain", domain: "other.test", sourcePropertyKey: "web" }],
        });
        await createRelationWithClient(client, edge(world.props.threadCompany, first.threadItemId, other), {
          ownerProcess: VALUE_LINKS_OWNER_PROCESS,
        });
      });
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([other]);
      expect(await linkRows(first.threadItemId)).toEqual([
        { property_key: "company", rule_key: "someOtherRule", state: "on" },
      ]);
    });

    it("writes nothing for an item that is not in the Threads database, does not exist or is in the trash", async () => {
      const rule = await companyRule();
      const acme = await company("Acme", "https://acme.cz");
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await cp.softDeleteItem(world.ids.threads, first.threadItemId);
      for (const itemId of [randomUUID(), acme, first.threadItemId])
        await tx((client) => evaluateResolverRule(client, rule, itemId, 1));
      expect(await linkRows(acme)).toEqual([]);
      expect(await linkRows(first.threadItemId)).toEqual([]);
    });

    it("announces a thread whose sources changed but whose value did not", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz", [acme]);
      const first = await received("<m1@acme>", "john@acme.cz");
      // The person gives up the address and the company's web no longer reaches the person: the unknown-sender
      // route finds the same company, with the sender domain as the source and the value as it was.
      await tx((client) => reindexPersonEmails(client, john, []));
      events.length = 0;
      const rule = await companyRule();
      await tx((client) => evaluateResolverRule(client, rule, first.threadItemId, 1));
      expect(await valueOf(first.threadItemId, "company")).toEqual([acme]);
      expect(await linkOf(first.threadItemId, "company")).toMatchObject({
        sources: [{ kind: "senderDomain", domain: "acme.cz" }],
      });
      expect(events.filter((event) => event.scope === "item" && event.itemId === first.threadItemId)).toHaveLength(1);
      events.length = 0;
      await tx((client) => evaluateResolverRule(client, rule, first.threadItemId, 1));
      expect(events.filter((event) => event.scope === "item")).toEqual([]);
    });

    it("finds nothing to evaluate or relink in a tenant without a Threads database", async () => {
      const rule = await companyRule();
      await runInTenant(await createTestTenant(admin), async () => {
        const itemId = randomUUID();
        await withTransaction(data, (client) => evaluateResolverRule(client, rule, itemId, 1));
        const relinked = await withTransaction(data, (client) =>
          relinkResolverLink(client, rule, {
            id: randomUUID(),
            itemId,
            propertyKey: "company",
            ruleKey: rule.key,
            state: "broken",
            brokenBy: "user",
            brokenAt: new Date().toISOString(),
          }),
        );
        expect(relinked).toBe(false);
        const rows = await data.query<{ n: number }>("SELECT count(*)::int AS n FROM value_links");
        expect(rows.rows).toEqual([{ n: 0 }]);
      });
    });
  });

  describe("relink of a sender-domain source", () => {
    it("restores the company when a company with that domain in its web exists, and refuses when none does", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      await clearValue(threadItemId, "company", acme);
      expect(await linkOf(threadItemId, "company")).toMatchObject({
        valueKind: "inheritedBroken",
        sources: [{ kind: "senderDomain", domain: "acme.cz" }],
      });
      expect(await cp.relinkValue({ itemId: threadItemId, propertyKey: "company" })).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "acme.cz" }],
        brokenBy: null,
      });
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);

      await clearValue(threadItemId, "company", acme);
      await setWeb(acme, "https://moved.test");
      await expect(cp.relinkValue({ itemId: threadItemId, propertyKey: "company" })).rejects.toMatchObject({
        status: 409,
        code: "value_link_conflict",
      });
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await linkOf(threadItemId, "company")).toMatchObject({ valueKind: "inheritedBroken" });
    });

    it("restores the company of a known person through the person as source", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz", [acme]);
      const { threadItemId } = await received("<m1@acme>", "john@acme.cz");
      await clearValue(threadItemId, "company", acme);
      expect(await cp.relinkValue({ itemId: threadItemId, propertyKey: "company" })).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: john }],
      });
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
    });
  });

  describe("invalidations", () => {
    it("publishes the thread's mailThread invalidation, once after the commit, for an inherited company and project", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await project("Active", acme);
      const first = await received("<m1@acme>", "sales@acme.cz");
      expect(mailThreadEvents().filter((event) => event.threadId === first.threadId)).toHaveLength(3);
      events.length = 0;
      await clearValue(first.threadItemId, "company", acme);
      expect(mailThreadEvents()).toEqual([{ scope: "mailThread", threadId: first.threadId }]);
    });

    it("publishes for a user's company or project too, and for no thread whose edge did not change", async () => {
      const chosen = await company("Chosen");
      const active = await project("Active", chosen);
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      await ingest("<m2@x>", "y@elsewhere.test");
      events.length = 0;
      await setValue(first.threadItemId, "company", chosen);
      await setValue(first.threadItemId, "project", active);
      expect(mailThreadEvents()).toEqual([
        { scope: "mailThread", threadId: first.threadId },
        { scope: "mailThread", threadId: first.threadId },
      ]);
    });

    it("publishes nothing for an edge of the thread that is neither company nor project, the company edge of a project or a person, or a metadata update of a thread's edge", async () => {
      const chosen = await company("Chosen");
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      await setValue(first.threadItemId, "company", chosen);
      const tasks = (await cp.listDatabases()).find((database) => database.ownerModuleId === "tasks");
      const tasksProperty = (await cp.listProperties(world.ids.threads)).find((entry) => entry.key === "tasks");
      if (!tasks || !tasksProperty) throw new Error("Missing Tasks or Threads.tasks");
      const task = await cp.createItem({ databaseId: tasks.id, properties: { name: "Task" } });
      events.length = 0;
      await cp.createRelation(edge(tasksProperty.id, first.threadItemId, task.id), USER);
      await project("Owned", chosen);
      await person("John", null, [chosen]);
      await cp.updateRelation(
        { ...edge(world.props.threadCompany, first.threadItemId, chosen), metadata: { note: "x" } },
        USER,
      );
      expect(mailThreadEvents()).toEqual([]);
    });

    it("announces nothing for a company edge written in a transaction that rolls back", async () => {
      const chosen = await company("Chosen");
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      events.length = 0;
      await expect(
        tx(async (client) => {
          await createRelationWithClient(
            client,
            edge(world.props.threadCompany, first.threadItemId, chosen),
            undefined,
            USER,
          );
          expect(events).toEqual([]);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(events).toEqual([]);
      expect(await valueOf(first.threadItemId, "company")).toEqual([]);
    });
  });

  describe("merging two threads", () => {
    async function pair(): Promise<{ older: Ingested; newer: Ingested }> {
      const threadOf = async (subject: string): Promise<Ingested> => {
        const thread = await tx((client) => createMailThread(client, subject));
        const { rows } = await query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
          thread.id,
        ]);
        if (!rows[0]) throw new Error("Missing thread");
        return { messageItemId: "", threadId: thread.id, threadItemId: rows[0].item_id };
      };
      const older = await threadOf("Older");
      return { older, newer: await threadOf("Newer") };
    }

    async function inheritCompany(thread: Ingested, ownerCompany: string, domain: string): Promise<void> {
      await tx(async (client) => {
        await insertValueLink(client, {
          itemId: thread.threadItemId,
          propertyKey: "company",
          ruleKey: "threadCompanyFromSender",
          sources: [{ kind: "senderDomain", domain, sourcePropertyKey: "web" }],
        });
        await createRelationWithClient(client, edge(world.props.threadCompany, thread.threadItemId, ownerCompany), {
          ownerProcess: VALUE_LINKS_OWNER_PROCESS,
        });
      });
    }

    const merge = (loser: Ingested, winner: Ingested) =>
      tx((client) => reassignThread(client, loser.threadId, winner.threadId));

    /** The merging pair, the loser and winner chosen by which of them is older. */
    async function mergingPair(olderIs: "winner" | "loser") {
      const { older, newer } = await pair();
      return olderIs === "winner" ? { winner: older, loser: newer } : { winner: newer, loser: older };
    }

    it.each([
      { olderIs: "loser", ownIs: "winner" },
      { olderIs: "winner", ownIs: "loser" },
    ] as const)(
      "takes the $ownIs's own company over an inherited one, although the $olderIs is older",
      async ({ olderIs, ownIs }) => {
        const { winner, loser } = await mergingPair(olderIs);
        const own = await company("Own");
        const inherited = await company("Inherited");
        const [ownThread, inheritingThread] = ownIs === "winner" ? [winner, loser] : [loser, winner];
        await inheritCompany(inheritingThread, inherited, "inherited.test");
        await setValue(ownThread.threadItemId, "company", own);
        await merge(loser, winner);
        expect(await valueOf(winner.threadItemId, "company")).toEqual([own]);
        expect(await linkRows(winner.threadItemId)).toEqual([]);
        expect(await linkRows(loser.threadItemId)).toEqual([]);
      },
    );

    it.each([
      { kind: "the user's own", olderIs: "winner" },
      { kind: "the user's own", olderIs: "loser" },
      { kind: "inherited", olderIs: "winner" },
      { kind: "inherited", olderIs: "loser" },
    ] as const)(
      "keeps the older thread's value when both are $kind: the $olderIs when it is older",
      async ({ kind, olderIs }) => {
        const { winner, loser } = await mergingPair(olderIs);
        const winners = await company("Winner's");
        const losers = await company("Loser's");
        if (kind === "inherited") {
          await inheritCompany(winner, winners, "winner.test");
          await inheritCompany(loser, losers, "loser.test");
        } else {
          await setValue(winner.threadItemId, "company", winners);
          await setValue(loser.threadItemId, "company", losers);
        }
        await merge(loser, winner);
        expect(await valueOf(winner.threadItemId, "company")).toEqual([olderIs === "winner" ? winners : losers]);
        expect(await linkRows(loser.threadItemId)).toEqual([]);
        if (kind === "inherited") {
          // The kept value keeps its link.
          expect(await linkOf(winner.threadItemId, "company")).toMatchObject({
            valueKind: "inherited",
            sources: [{ kind: "senderDomain", domain: olderIs === "winner" ? "winner.test" : "loser.test" }],
          });
          expect(await linkRows(winner.threadItemId)).toEqual([
            { property_key: "company", rule_key: "threadCompanyFromSender", state: "on" },
          ]);
        }
      },
    );

    it("gives a winner without a value the loser's inherited value and its link", async () => {
      const { winner, loser } = await mergingPair("winner");
      const inherited = await company("Inherited");
      await inheritCompany(loser, inherited, "inherited.test");
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([inherited]);
      expect(await linkOf(winner.threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "inherited.test" }],
      });
      expect(await linkRows(loser.threadItemId)).toEqual([]);
    });

    it("keeps a broken link as the thread's own value and decides by kind and age like any own value", async () => {
      const { winner, loser } = await mergingPair("loser");
      const winners = await company("Winner's");
      const losers = await company("Loser's");
      await inheritCompany(loser, losers, "loser.test");
      await clearValue(loser.threadItemId, "company", losers);
      await setValue(loser.threadItemId, "company", losers);
      expect(await linkOf(loser.threadItemId, "company")).toMatchObject({ valueKind: "inheritedBroken" });
      await setValue(winner.threadItemId, "company", winners);
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([losers]);
      expect(await linkOf(winner.threadItemId, "company")).toMatchObject({ valueKind: "inheritedBroken" });
    });

    it("decides the project on its own, apart from the company", async () => {
      const { winner, loser } = await mergingPair("loser");
      const winnersCompany = await company("Winner's company");
      const losersProject = await project("Loser's project", null);
      await setValue(winner.threadItemId, "company", winnersCompany);
      await setValue(loser.threadItemId, "project", losersProject);
      await setValue(winner.threadItemId, "project", await project("Winner's project", null));
      await merge(loser, winner);
      expect(await valuesOf(winner.threadItemId)).toEqual({ company: [winnersCompany], project: [losersProject] });
    });

    it("recomputes an inherited project of the winner after the company changed by the merge", async () => {
      const { winner, loser } = await mergingPair("loser");
      const first = await company("First", "https://first.test");
      const firstProject = await project("First project", first);
      const second = await company("Second");
      const secondProject = await project("Second project", second);
      await setValue(winner.threadItemId, "company", first);
      await runPropagation();
      expect(await valueOf(winner.threadItemId, "project")).toEqual([firstProject]);
      await setValue(loser.threadItemId, "company", second);
      await merge(loser, winner);
      await runPropagation();
      expect(await valuesOf(winner.threadItemId)).toEqual({ company: [second], project: [secondProject] });
    });

    it("recomputes what the winner's attachments inherit through the propagation job", async () => {
      const { winner, loser } = await mergingPair("loser");
      const spy = vi.spyOn(linkPropagation, "scheduleDownstream");
      await merge(loser, winner);
      expect(
        spy.mock.calls.map(([, databaseKey, propertyKey, itemId, hop]) => [databaseKey, propertyKey, itemId, hop]),
      ).toEqual([["threads", "project", winner.threadItemId, 1]]);
    });

    it("refuses to plan a merge of threads that have no row", async () => {
      const { older, newer } = await pair();
      await expect(
        tx((client) =>
          planThreadValueMerge(client, {
            winnerItemId: newer.threadItemId,
            loserItemId: older.threadItemId,
            winnerThreadId: randomUUID(),
            loserThreadId: older.threadId,
          }),
        ),
      ).rejects.toThrow("Invalid Threads merge binding");
    });

    it("leaves the thread untouched when the merge rolls back", async () => {
      const { winner, loser } = await mergingPair("loser");
      const own = await company("Own");
      await setValue(loser.threadItemId, "company", own);
      await expect(
        tx(async (client) => {
          await reassignThread(client, loser.threadId, winner.threadId);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(await valueOf(loser.threadItemId, "company")).toEqual([own]);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([]);
    });
  });

  describe("tenant isolation", () => {
    it.each([
      // A company of the other tenant on the same domain would make two matches and so no company.
      { name: "takes its own tenant's company of the sender's domain", ownCompany: true },
      { name: "gives no company when only the other tenant has one", ownCompany: false },
    ])("matches a sender only against the companies of its own tenant: $name", async ({ ownCompany }) => {
      await companyInOtherTenant("https://acme.cz");
      const own = ownCompany ? await company("Acme A", "https://acme.cz") : null;
      const { threadItemId } = await received("<m1@acme>", "sales@acme.cz");
      expect(await valueOf(threadItemId, "company")).toEqual(own ? [own] : []);
      if (!own) expect(await linkRows(threadItemId)).toEqual([]);
      expect(await tx((client) => mailThreadIdOfItem(client, threadItemId))).not.toBeNull();
    });
  });
});
