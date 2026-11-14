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

/** A transaction of the runtime role in the test tenant. */
const tx = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => inTenant(() => withTransaction(data, fn));

/** A query of the runtime role in the test tenant. */
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
  if (ownerCompany)
    await cp.createRelation(
      { relationPropertyId: world.props.projectCompany, callerItemId: created.id, targetItemId: ownerCompany },
      USER,
    );
  return created.id;
}

async function person(name: string, address: string | null, companies: string[] = []): Promise<string> {
  const created = await cp.createItem({ databaseId: world.ids.people, properties: { name } });
  if (address) await tx((client) => reindexPersonEmails(client, created.id, [address]));
  for (const target of companies)
    await cp.createRelation(
      { relationPropertyId: world.props.personCompanies, callerItemId: created.id, targetItemId: target },
      USER,
    );
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
async function runPropagation(): Promise<void> {
  const handler = createCoreTaskList(data, createActionRegistry())[CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE];
  if (!handler) throw new Error("Propagation handler missing");
  const pending = async () =>
    (
      await admin.query<{ key: string; last_error: string | null }>(
        `SELECT j.key, j.last_error FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1`,
        [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
      )
    ).rows;
  for (let round = 0; round < 60; round++) {
    if ((await pending()).length === 0) return;
    await runOnce({ pgPool: data, taskList: { [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: handler } });
  }
  throw new Error(`Propagation jobs left: ${JSON.stringify(await pending())}`);
}

async function valueOf(threadItemId: string, key: "company" | "project"): Promise<string[]> {
  const propertyId = key === "company" ? world.props.threadCompany : world.props.threadProject;
  return ((await cp.listItemRelations(threadItemId, propertyId)) ?? []).map((edge) => edge.targetItemId).sort();
}

async function linkOf(threadItemId: string, key: "company" | "project"): Promise<ValueLinkEntry | undefined> {
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

const setValue = (threadItemId: string, key: "company" | "project", targetItemId: string) =>
  cp.createRelation(
    {
      relationPropertyId: key === "company" ? world.props.threadCompany : world.props.threadProject,
      callerItemId: threadItemId,
      targetItemId,
    },
    USER,
  );

const clearValue = (threadItemId: string, key: "company" | "project", targetItemId: string) =>
  cp.deleteRelation(
    {
      relationPropertyId: key === "company" ? world.props.threadCompany : world.props.threadProject,
      callerItemId: threadItemId,
      targetItemId,
    },
    USER,
  );

describe("the Threads company and project link rules (issue gh-1869)", () => {
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
      const { threadItemId } = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
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
      const { threadItemId } = await ingest("<m1@acme>", "John@Mail.ACME.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
    });

    it("gives a thread from an unknown address of a company's domain that company, with the sender domain as its source", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
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

    it("gives a freemail address of a person in a company no company and no project, and writes no link", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await project("Active", acme);
      await person("John", "john@gmail.com", [acme]);
      const { threadItemId } = await ingest("<m1@gmail>", "john@gmail.com");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("never matches a freemail domain, even for a company whose web is that domain", async () => {
      await company("Gmail fan club", "https://gmail.com");
      const { threadItemId } = await ingest("<m1@gmail>", "someone@gmail.com");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("looks only at the companies of a known person: a company of the domain that the person is not in does not match", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other", "https://other.cz");
      await person("John", "john@acme.cz", [other]);
      const { threadItemId } = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
      expect(acme).toBeTruthy();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
    });

    it("gives no company when several companies of a known person match, or several companies of the domain match an unknown sender", async () => {
      const first = await company("Acme", "https://acme.cz");
      const second = await company("Acme Labs", "https://labs.acme.cz");
      await person("John", "john@labs.acme.cz", [first, second]);
      const known = await ingest("<m1@acme>", "john@labs.acme.cz");
      const unknown = await ingest("<m2@acme>", "sales@labs.acme.cz");
      await runPropagation();
      expect(await valueOf(known.threadItemId, "company")).toEqual([]);
      expect(await valueOf(unknown.threadItemId, "company")).toEqual([]);
    });

    it("gives no company when no company matches the domain", async () => {
      await company("Acme", "https://acme.cz");
      const { threadItemId } = await ingest("<m1@x>", "someone@elsewhere.test");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("takes the sender from the first inbound message, not from the user's own mail sent before it", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other", "https://other.cz");
      const own = await ingest("<own@x>", OWN_ADDRESS, { folder: "sent", date: "2026-01-01T10:00:00Z" });
      const first = await ingest("<m1@acme>", "sales@acme.cz", {
        inReplyTo: "<own@x>",
        date: "2026-01-02T10:00:00Z",
      });
      expect(first.threadId).toBe(own.threadId);
      await ingest("<m2@other>", "sales@other.cz", { inReplyTo: "<own@x>", date: "2026-01-03T10:00:00Z" });
      await runPropagation();
      expect(await valueOf(own.threadItemId, "company")).toEqual([acme]);
      expect(other).toBeTruthy();
      expect(await firstInboundOf(own.threadId)).toEqual({
        itemId: first.messageItemId,
        senderAddress: "sales@acme.cz",
      });
    });

    it("leaves a company the user chose before the first message of the thread was evaluated as the user's own", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const chosen = await company("Chosen");
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await setValue(first.threadItemId, "company", chosen);
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([chosen]);
      expect(await linkRows(first.threadItemId)).toEqual([]);
      expect(acme).toBeTruthy();
    });

    it("follows the sender when the first inbound message changes: an earlier-dated message from another company replaces the company", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other", "https://other.cz");
      const first = await ingest("<m1@acme>", "sales@acme.cz", { date: "2026-01-05T10:00:00Z" });
      await runPropagation();
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
      const other = await company("Other", "https://other.cz");
      const first = await ingest("<m1@acme>", "sales@acme.cz", { date: "2026-01-01T10:00:00Z" });
      await runPropagation();
      const spy = vi.spyOn(linkPropagation, "enqueueLinkPropagation");
      await ingest("<m2@other>", "sales@other.cz", { inReplyTo: "<m1@acme>", date: "2026-01-02T10:00:00Z" });
      await ingest("<m3@x>", OWN_ADDRESS, { folder: "sent", inReplyTo: "<m1@acme>", date: "2026-01-03T10:00:00Z" });
      expect(spy).not.toHaveBeenCalled();
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([acme]);
      expect(other).toBeTruthy();
    });

    it("evaluates both rules for the thread when the new message is its first inbound one", async () => {
      await company("Acme", "https://acme.cz");
      const spy = vi.spyOn(linkPropagation, "enqueueLinkPropagation");
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      expect(spy.mock.calls.map(([, ruleKey, itemId, hop]) => [ruleKey, itemId, hop])).toEqual([
        ["threadCompanyFromSender", first.threadItemId, 1],
        ["threadProjectFromCompany", first.threadItemId, 1],
      ]);
    });

    it("evaluates nothing for an outgoing first message", async () => {
      await company("Acme", "https://acme.cz");
      const spy = vi.spyOn(linkPropagation, "enqueueLinkPropagation");
      await ingest("<own@x>", OWN_ADDRESS, { folder: "sent" });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("the project rule", () => {
    it("gives the thread the single active project of its company, marked inherited with the company as its source", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const active = await project("Active", acme, "inProgress");
      await project("Finished", acme, "done");
      await project("Archived", acme, "archived");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      expect(await linkOf(threadItemId, "project")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: acme, databaseKey: "companies", propertyKey: "projects" }],
      });
    });

    it("counts a long-term project as active", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const longTerm = await project("Long term", acme, "longTerm");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([longTerm]);
    });

    it("gives no project for a company without an active project or with several", async () => {
      const none = await company("None", "https://none.test");
      await project("Done", none, "done");
      const several = await company("Several", "https://several.test");
      await project("One", several, "inProgress");
      await project("Two", several, "longTerm");
      const first = await ingest("<m1@none>", "x@none.test");
      const second = await ingest("<m2@several>", "x@several.test");
      await runPropagation();
      expect(await valueOf(first.threadItemId, "company")).toEqual([none]);
      expect(await valueOf(first.threadItemId, "project")).toEqual([]);
      expect(await valueOf(second.threadItemId, "company")).toEqual([several]);
      expect(await valueOf(second.threadItemId, "project")).toEqual([]);
      expect(await linkRows(first.threadItemId)).toEqual([
        { property_key: "company", rule_key: "threadCompanyFromSender", state: "on" },
      ]);
    });

    it("inherits from a company the user entered, as from an inherited one", async () => {
      const chosen = await company("Chosen");
      const active = await project("Active", chosen);
      const { threadItemId } = await ingest("<m1@x>", "someone@elsewhere.test");
      await runPropagation();
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
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([first]);
      const second = await project("Second", acme, "done");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([first]);
      await cp.updateItem({ databaseId: world.ids.projects, itemId: first, propertiesPatch: { status: "done" } });
      await cp.updateItem({
        databaseId: world.ids.projects,
        itemId: second,
        propertiesPatch: { status: "inProgress" },
      });
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([second]);
    });

    it("follows an edge change of the company's projects", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      const added = await project("Added", acme);
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([added]);
      await cp.deleteRelation(
        { relationPropertyId: world.props.projectCompany, callerItemId: added, targetItemId: acme },
        USER,
      );
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      expect(await linkOf(threadItemId, "project")).toBeUndefined();
    });

    it("ends the project link when the user sets the project by hand, leaves it alone on a later change of the company's project, and restores it on relink", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const inherited = await project("Inherited", acme);
      const byHand = await project("By hand", null);
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([inherited]);

      await clearValue(threadItemId, "project", inherited);
      await setValue(threadItemId, "project", byHand);
      expect(await linkOf(threadItemId, "project")).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });

      const later = await project("Later", acme);
      await cp.updateItem({ databaseId: world.ids.projects, itemId: inherited, propertiesPatch: { status: "done" } });
      await runPropagation();
      expect(later).toBeTruthy();
      expect(await valueOf(threadItemId, "project")).toEqual([byHand]);
      expect(await linkOf(threadItemId, "project")).toMatchObject({ valueKind: "inheritedBroken" });

      const relinked = await cp.relinkValue({ itemId: threadItemId, propertyKey: "project" });
      expect(relinked).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "item", itemId: acme, propertyKey: "projects" }],
      });
      expect(await valueOf(threadItemId, "project")).toEqual([later]);
    });

    it("refuses to relink a project when the company has no single active project", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const inherited = await project("Inherited", acme);
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      await clearValue(threadItemId, "project", inherited);
      await cp.updateItem({ databaseId: world.ids.projects, itemId: inherited, propertiesPatch: { status: "done" } });
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
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      await clearValue(threadItemId, "company", acme);
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([
        { property_key: "company", rule_key: "threadCompanyFromSender", state: "broken" },
      ]);
    });

    it("keeps a project the user entered when the company is cleared", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const inherited = await project("Inherited", acme);
      const byHand = await project("By hand", null);
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
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
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "project")).toEqual([active]);
      await cp.updateItem({
        databaseId: world.ids.companies,
        itemId: acme,
        propertiesPatch: { web: "https://moved.test" },
      });
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await valueOf(threadItemId, "project")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("gives an empty thread the company when a company's web starts to match its sender's domain", async () => {
      const acme = await company("Acme");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await cp.updateItem({
        databaseId: world.ids.companies,
        itemId: acme,
        propertiesPatch: { web: "https://acme.cz" },
      });
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
    });

    it("gives a thread the company created with a web that matches its sender's domain", async () => {
      const { threadItemId } = await ingest("<m1@newco>", "sales@newco.test");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      const newCo = await company("NewCo", "https://newco.test");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([newCo]);
      expect(await linkOf(threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "newco.test" }],
      });
    });

    it("gives a thread the company restored from the trash with a web that matches its sender's domain", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await tx((client) =>
        itemDeleteWithClient(client, world.ids.companies, acme, { queueAffinity: createActionQueueAffinity() }),
      );
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await tx((client) => restoreItemWithClient(client, world.ids.companies, acme, createActionQueueAffinity()));
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
    });

    it("queues nothing for a company created without a web, a created project or an item of a database no rule reads", async () => {
      await company("NoWeb");
      await project("Planned", null);
      await cp.createItem({ databaseId: world.ids.people, properties: { name: "Jane" } });
      const { rows } = await admin.query<{ key: string }>(
        `SELECT j.key FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1`,
        [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
      );
      expect(rows).toEqual([]);
    });

    it("gives the remaining company to a thread that matched two companies of one domain when one of them changes its web", async () => {
      const first = await company("First", "https://acme.cz");
      const second = await company("Second", "https://www.acme.cz");
      const secondProject = await project("Second project", second);
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await cp.updateItem({
        databaseId: world.ids.companies,
        itemId: first,
        propertiesPatch: { web: "https://other.test" },
      });
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([second]);
      expect(await valueOf(threadItemId, "project")).toEqual([secondProject]);
    });

    it("gives the remaining company to a thread that matched two companies of one domain when one of them clears its web", async () => {
      const first = await company("First", "https://acme.cz");
      const second = await company("Second", "https://acme.cz");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await cp.updateItem({ databaseId: world.ids.companies, itemId: first, propertiesPatch: { web: "" } });
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([second]);
    });

    it("gives the remaining company to a thread of a known person who matched two of the person's companies of one domain", async () => {
      const first = await company("First", "https://acme.cz");
      const second = await company("Second", "https://acme.cz");
      await person("John", "john@acme.cz", [first, second]);
      const { threadItemId } = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await cp.updateItem({
        databaseId: world.ids.companies,
        itemId: first,
        propertiesPatch: { web: "https://other.test" },
      });
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([second]);
    });

    it("gives the threads of a known person the company when the person joins it, and takes it away when the person leaves", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz");
      const { threadItemId } = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      await cp.createRelation(
        { relationPropertyId: world.props.personCompanies, callerItemId: john, targetItemId: acme },
        USER,
      );
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
      await cp.deleteRelation(
        { relationPropertyId: world.props.personCompanies, callerItemId: john, targetItemId: acme },
        USER,
      );
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
    });

    it("does not touch a thread of another person or of a company the change does not concern", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other", "https://other.cz");
      const otherProject = await project("Other project", other);
      const john = await person("John", "john@acme.cz");
      const jane = await person("Jane", "jane@other.cz", [other]);
      const johns = await ingest("<m1@acme>", "john@acme.cz");
      const janes = await ingest("<m2@other>", "jane@other.cz");
      await runPropagation();
      expect(await valueOf(janes.threadItemId, "company")).toEqual([other]);
      await cp.createRelation(
        { relationPropertyId: world.props.personCompanies, callerItemId: john, targetItemId: acme },
        USER,
      );
      await runPropagation();
      expect(await valueOf(johns.threadItemId, "company")).toEqual([acme]);
      expect(await valueOf(janes.threadItemId, "company")).toEqual([other]);
      expect(await valueOf(janes.threadItemId, "project")).toEqual([otherProject]);
      expect(jane).toBeTruthy();
    });
  });

  describe("resolvers read directly", () => {
    const resolveCompany = (threadItemId: string) =>
      tx((client) => threadCompanyLinkResolver.resolve(client, threadItemId));
    const affected = (
      resolver: typeof threadCompanyLinkResolver,
      changed: string,
      afterId: string | null,
      limit: number,
    ) => tx((client) => resolver.affectedItemIds(client, changed, afterId, limit));

    it("gives no company for a thread that has no inbound message", async () => {
      await company("Acme", "https://acme.cz");
      const own = await ingest("<own@x>", OWN_ADDRESS, { folder: "sent" });
      expect(await resolveCompany(own.threadItemId)).toEqual({ values: [], sources: [] });
      expect(await firstInboundOf(own.threadId)).toBeNull();
    });

    it("gives no company for a sender whose address has no domain", async () => {
      await company("Acme", "https://acme.cz");
      const odd = await ingest("<odd@x>", "no-domain");
      expect(await resolveCompany(odd.threadItemId)).toEqual({ values: [], sources: [] });
    });

    it("gives no company for a thread item that is bound to no mail thread", async () => {
      expect(await resolveCompany(randomUUID())).toEqual({ values: [], sources: [] });
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
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      await cp.softDeleteItem(world.ids.companies, acme);
      expect(await tx((client) => threadProjectLinkResolver.resolve(client, first.threadItemId))).toEqual({
        values: [],
        sources: [],
      });
    });

    it("names no affected item for a changed item of another database, a missing item or a trashed one", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const active = await project("Active", acme);
      const gone = await company("Gone");
      await cp.softDeleteItem(world.ids.companies, gone);
      for (const changed of [active, randomUUID(), gone]) {
        expect(await affected(threadCompanyLinkResolver, changed, null, 10)).toEqual([]);
      }
      for (const changed of [randomUUID(), gone]) {
        expect(await affected(threadProjectLinkResolver, changed, null, 10)).toEqual([]);
      }
      const person1 = await person("John", null);
      expect(await affected(threadProjectLinkResolver, person1, null, 10)).toEqual([]);
    });

    it("names a thread itself for a change of that thread, only on the first page", async () => {
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      expect(await affected(threadCompanyLinkResolver, first.threadItemId, null, 10)).toEqual([first.threadItemId]);
      expect(await affected(threadProjectLinkResolver, first.threadItemId, null, 10)).toEqual([first.threadItemId]);
      expect(await affected(threadCompanyLinkResolver, first.threadItemId, first.threadItemId, 10)).toEqual([]);
      expect(await affected(threadProjectLinkResolver, first.threadItemId, first.threadItemId, 10)).toEqual([]);
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
      expect(await affected(threadProjectLinkResolver, owned, null, 10)).toEqual([first.threadItemId]);
      expect(await affected(threadProjectLinkResolver, orphan, null, 10)).toEqual([]);
    });

    it("names the threads of a person by the person's addresses and by the links the person is the source of", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz", [acme]);
      const written = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
      expect(await affected(threadCompanyLinkResolver, john, null, 10)).toEqual([written.threadItemId]);
      // The person gives the address up: the thread is still named, through the link that has the person as its source.
      await tx((client) => reindexPersonEmails(client, john, []));
      expect(await affected(threadCompanyLinkResolver, john, null, 10)).toEqual([written.threadItemId]);
      expect(await affected(threadCompanyLinkResolver, john, written.threadItemId, 10)).toEqual([]);
    });

    it("names the threads without a company that were written from a domain of another company's host, for a change of a company", async () => {
      const first = await company("First", "https://acme.cz");
      await company("Second", "https://acme.cz");
      const ambiguous = await ingest("<m1@acme>", "sales@acme.cz");
      const elsewhere = await ingest("<m2@x>", "sales@elsewhere.test");
      await runPropagation();
      expect(await affected(threadCompanyLinkResolver, first, null, 10)).toEqual([ambiguous.threadItemId]);
      expect(elsewhere.threadItemId).toBeTruthy();
    });

    it("names no thread of another company's host that already holds a company, for a change of a company", async () => {
      const first = await company("First", "https://other.test");
      await company("Second", "https://acme.cz");
      await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await affected(threadCompanyLinkResolver, first, null, 10)).toEqual([]);
    });

    it("names no thread of a company whose web holds no host, and the threads that hold it", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      await cp.updateItem({ databaseId: world.ids.companies, itemId: acme, propertiesPatch: { web: "" } });
      expect(await affected(threadCompanyLinkResolver, acme, null, 10)).toEqual([first.threadItemId]);
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
      const acme = await company("Acme", "https://acme.cz");
      const other = await company("Other");
      const first = await ingest("<m1@x>", "sales@acme.cz");
      await tx((client) =>
        insertValueLink(client, {
          itemId: first.threadItemId,
          propertyKey: "company",
          ruleKey: "someOtherRule",
          sources: [{ kind: "senderDomain", domain: "other.test", sourcePropertyKey: "web" }],
        }),
      );
      await tx((client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: world.props.threadCompany, callerItemId: first.threadItemId, targetItemId: other },
          { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
        ),
      );
      await runPropagation();
      expect(acme).toBeTruthy();
      expect(await valueOf(first.threadItemId, "company")).toEqual([other]);
      expect(await linkRows(first.threadItemId)).toEqual([
        { property_key: "company", rule_key: "someOtherRule", state: "on" },
      ]);
    });

    it("writes nothing for an item that is not in the Threads database or does not exist", async () => {
      const rule = await companyRule();
      const acme = await company("Acme", "https://acme.cz");
      await tx((client) => evaluateResolverRule(client, rule, randomUUID(), 1));
      await tx((client) => evaluateResolverRule(client, rule, acme, 1));
      expect(await linkRows(acme)).toEqual([]);
    });

    it("writes nothing for a thread item in the trash", async () => {
      const rule = await companyRule();
      await company("Acme", "https://acme.cz");
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await cp.softDeleteItem(world.ids.threads, first.threadItemId);
      await tx((client) => evaluateResolverRule(client, rule, first.threadItemId, 1));
      expect(await linkRows(first.threadItemId)).toEqual([]);
    });

    it("announces a thread whose sources changed but whose value did not", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const john = await person("John", "john@acme.cz", [acme]);
      const first = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
      expect(john).toBeTruthy();
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
      const bare = await createTestTenant(admin);
      await runInTenant(bare, async () => {
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

  describe("the first inbound message", () => {
    it("queues nothing for a message that has no mail message row", async () => {
      const spy = vi.spyOn(linkPropagation, "enqueueLinkPropagation");
      await tx((client) => enqueueThreadLinkRulesForFirstInbound(client, randomUUID()));
      expect(spy).not.toHaveBeenCalled();
    });

    it("queues nothing for a thread that is bound to no Threads item", async () => {
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      await tx((client) => client.query("UPDATE mail_threads SET item_id = NULL WHERE id = $1", [first.threadId]));
      const spy = vi.spyOn(linkPropagation, "enqueueLinkPropagation");
      await tx((client) => enqueueThreadLinkRulesForFirstInbound(client, first.messageItemId));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("relink of a sender-domain source", () => {
    it("restores the company when a company with that domain in its web exists, and refuses when none does", async () => {
      const acme = await company("Acme", "https://acme.cz");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      await clearValue(threadItemId, "company", acme);
      expect(await linkOf(threadItemId, "company")).toMatchObject({
        valueKind: "inheritedBroken",
        sources: [{ kind: "senderDomain", domain: "acme.cz" }],
      });
      const relinked = await cp.relinkValue({ itemId: threadItemId, propertyKey: "company" });
      expect(relinked).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "acme.cz" }],
        brokenBy: null,
      });
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);

      await clearValue(threadItemId, "company", acme);
      await cp.updateItem({
        databaseId: world.ids.companies,
        itemId: acme,
        propertiesPatch: { web: "https://moved.test" },
      });
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
      const { threadItemId } = await ingest("<m1@acme>", "john@acme.cz");
      await runPropagation();
      await clearValue(threadItemId, "company", acme);
      const relinked = await cp.relinkValue({ itemId: threadItemId, propertyKey: "company" });
      expect(relinked).toMatchObject({ valueKind: "inherited", sources: [{ kind: "item", itemId: john }] });
      expect(await valueOf(threadItemId, "company")).toEqual([acme]);
    });
  });

  describe("invalidations", () => {
    it("publishes the thread's mailThread invalidation, once after the commit, for an inherited company and project", async () => {
      const acme = await company("Acme", "https://acme.cz");
      await project("Active", acme);
      const first = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      const announced = events.filter((event) => event.scope === "mailThread" && event.threadId === first.threadId);
      // One for the new message, one for the company edge, one for the project edge.
      expect(announced).toHaveLength(3);
      events.length = 0;
      await clearValue(first.threadItemId, "company", acme);
      expect(events.filter((event) => event.scope === "mailThread")).toEqual([
        { scope: "mailThread", threadId: first.threadId },
      ]);
    });

    it("publishes for a user's company or project too, and for no thread whose edge did not change", async () => {
      const chosen = await company("Chosen");
      const active = await project("Active", chosen);
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      const second = await ingest("<m2@x>", "y@elsewhere.test");
      events.length = 0;
      await setValue(first.threadItemId, "company", chosen);
      await setValue(first.threadItemId, "project", active);
      expect(events.filter((event) => event.scope === "mailThread")).toEqual([
        { scope: "mailThread", threadId: first.threadId },
        { scope: "mailThread", threadId: first.threadId },
      ]);
      expect(events.some((event) => event.scope === "mailThread" && event.threadId === second.threadId)).toBe(false);
    });

    it("publishes nothing for an edge of the thread that is neither company nor project", async () => {
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      const task = await cp.createItem({
        databaseId: (await cp.listDatabases()).find((database) => database.ownerModuleId === "tasks")!.id,
        properties: { name: "Task" },
      });
      const tasksProperty = (await cp.listProperties(world.ids.threads)).find((entry) => entry.key === "tasks");
      if (!tasksProperty) throw new Error("Missing Threads.tasks");
      events.length = 0;
      await cp.createRelation(
        { relationPropertyId: tasksProperty.id, callerItemId: first.threadItemId, targetItemId: task.id },
        USER,
      );
      expect(events.filter((event) => event.scope === "mailThread")).toEqual([]);
    });

    it("publishes nothing for the company edge of a project or a person, nor for a metadata update of a thread's edge", async () => {
      const chosen = await company("Chosen");
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      await setValue(first.threadItemId, "company", chosen);
      events.length = 0;
      await project("Owned", chosen);
      await person("John", null, [chosen]);
      await cp.updateRelation(
        {
          relationPropertyId: world.props.threadCompany,
          callerItemId: first.threadItemId,
          targetItemId: chosen,
          metadata: { note: "x" },
        },
        USER,
      );
      expect(events.filter((event) => event.scope === "mailThread")).toEqual([]);
    });

    it("announces nothing for a company edge written in a transaction that rolls back", async () => {
      const chosen = await company("Chosen");
      const first = await ingest("<m1@x>", "x@elsewhere.test");
      events.length = 0;
      await expect(
        tx(async (client) => {
          await createRelationWithClient(
            client,
            { relationPropertyId: world.props.threadCompany, callerItemId: first.threadItemId, targetItemId: chosen },
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
    interface Pair {
      older: Ingested;
      newer: Ingested;
    }

    async function pair(): Promise<Pair> {
      const olderThread = await tx((client) => createMailThread(client, "Older"));
      const newerThread = await tx((client) => createMailThread(client, "Newer"));
      const itemOf = async (threadId: string): Promise<string> => {
        const { rows } = await query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [threadId]);
        const row = rows[0];
        if (!row) throw new Error("Missing thread");
        return row.item_id;
      };
      return {
        older: { messageItemId: "", threadId: olderThread.id, threadItemId: await itemOf(olderThread.id) },
        newer: { messageItemId: "", threadId: newerThread.id, threadItemId: await itemOf(newerThread.id) },
      };
    }

    /** Gives a thread an inherited company: the link `on` first, then the edge, as the engine writes them. */
    async function inheritCompany(thread: Ingested, ownerCompany: string, domain: string): Promise<void> {
      await tx(async (client) => {
        await insertValueLink(client, {
          itemId: thread.threadItemId,
          propertyKey: "company",
          ruleKey: "threadCompanyFromSender",
          sources: [{ kind: "senderDomain", domain, sourcePropertyKey: "web" }],
        });
        await createRelationWithClient(
          client,
          {
            relationPropertyId: world.props.threadCompany,
            callerItemId: thread.threadItemId,
            targetItemId: ownerCompany,
          },
          { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
        );
      });
    }

    const merge = (loser: Ingested, winner: Ingested) =>
      tx((client) => reassignThread(client, loser.threadId, winner.threadId));

    it("keeps the winner's own company over an inherited one of the loser, although the loser is older", async () => {
      const { older: loser, newer: winner } = await pair();
      const own = await company("Own");
      const inherited = await company("Inherited");
      await inheritCompany(loser, inherited, "inherited.test");
      await setValue(winner.threadItemId, "company", own);
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([own]);
      expect(await linkRows(winner.threadItemId)).toEqual([]);
      expect(await linkRows(loser.threadItemId)).toEqual([]);
    });

    it("takes the loser's own company over an inherited one of the winner, although the winner is older", async () => {
      const { older: winner, newer: loser } = await pair();
      const own = await company("Own");
      const inherited = await company("Inherited");
      await inheritCompany(winner, inherited, "inherited.test");
      await setValue(loser.threadItemId, "company", own);
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([own]);
      expect(await linkRows(winner.threadItemId)).toEqual([]);
      expect(await linkOf(winner.threadItemId, "company")).toBeUndefined();
    });

    it("keeps the older thread's value when both are the user's own: the winner when it is older", async () => {
      const { older: winner, newer: loser } = await pair();
      const winners = await company("Winner's");
      const losers = await company("Loser's");
      await setValue(winner.threadItemId, "company", winners);
      await setValue(loser.threadItemId, "company", losers);
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([winners]);
    });

    it("keeps the older thread's value when both are the user's own: the loser when it is older", async () => {
      const { older: loser, newer: winner } = await pair();
      const winners = await company("Winner's");
      const losers = await company("Loser's");
      await setValue(winner.threadItemId, "company", winners);
      await setValue(loser.threadItemId, "company", losers);
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([losers]);
    });

    it("keeps the older thread's value when both are inherited, and its link with it: the winner when it is older", async () => {
      const { older: winner, newer: loser } = await pair();
      const winners = await company("Winner's");
      const losers = await company("Loser's");
      await inheritCompany(winner, winners, "winner.test");
      await inheritCompany(loser, losers, "loser.test");
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([winners]);
      expect(await linkOf(winner.threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "winner.test" }],
      });
    });

    it("keeps the older thread's value when both are inherited, and its link with it: the loser when it is older", async () => {
      const { older: loser, newer: winner } = await pair();
      const winners = await company("Winner's");
      const losers = await company("Loser's");
      await inheritCompany(winner, winners, "winner.test");
      await inheritCompany(loser, losers, "loser.test");
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([losers]);
      expect(await linkOf(winner.threadItemId, "company")).toMatchObject({
        valueKind: "inherited",
        sources: [{ kind: "senderDomain", domain: "loser.test" }],
      });
      expect(await linkRows(winner.threadItemId)).toEqual([
        { property_key: "company", rule_key: "threadCompanyFromSender", state: "on" },
      ]);
      expect(await linkRows(loser.threadItemId)).toEqual([]);
    });

    it("gives a winner without a value the loser's inherited value and its link", async () => {
      const { older: winner, newer: loser } = await pair();
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
      const { older: loser, newer: winner } = await pair();
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
      const { older: loser, newer: winner } = await pair();
      const winnersCompany = await company("Winner's company");
      const losersProject = await project("Loser's project", null);
      const winnersProject = await project("Winner's project", null);
      await setValue(winner.threadItemId, "company", winnersCompany);
      await setValue(loser.threadItemId, "project", losersProject);
      await setValue(winner.threadItemId, "project", winnersProject);
      await merge(loser, winner);
      expect(await valueOf(winner.threadItemId, "company")).toEqual([winnersCompany]);
      expect(await valueOf(winner.threadItemId, "project")).toEqual([losersProject]);
    });

    it("recomputes an inherited project of the winner after the company changed by the merge", async () => {
      const { older: loser, newer: winner } = await pair();
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
      expect(await valueOf(winner.threadItemId, "company")).toEqual([second]);
      expect(await valueOf(winner.threadItemId, "project")).toEqual([secondProject]);
    });

    it("recomputes what the winner's attachments inherit through the propagation job", async () => {
      const { older: loser, newer: winner } = await pair();
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
      const { older: loser, newer: winner } = await pair();
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
    it("matches a sender only against the companies of its own tenant", async () => {
      const otherTenant = await createTestTenant(admin);
      await runInTenant(otherTenant, async () => {
        await seedSystem(data);
        const otherCp = createChokePoint(data);
        const companies = (await otherCp.listDatabases()).find((database) => database.ownerModuleId === "companies");
        if (!companies) throw new Error("Missing companies");
        await otherCp.createItem({ databaseId: companies.id, properties: { name: "Acme B", web: "https://acme.cz" } });
      });
      const own = await company("Acme A", "https://acme.cz");
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      // A company of the other tenant on the same domain would make two matches and so no company.
      expect(await valueOf(threadItemId, "company")).toEqual([own]);
    });

    it("leaves a thread of this tenant without a company when only another tenant has a company on its sender's domain", async () => {
      const otherTenant = await createTestTenant(admin);
      await runInTenant(otherTenant, async () => {
        await seedSystem(data);
        const otherCp = createChokePoint(data);
        const companies = (await otherCp.listDatabases()).find((database) => database.ownerModuleId === "companies");
        if (!companies) throw new Error("Missing companies");
        await otherCp.createItem({ databaseId: companies.id, properties: { name: "Acme B", web: "https://acme.cz" } });
      });
      const { threadItemId } = await ingest("<m1@acme>", "sales@acme.cz");
      await runPropagation();
      expect(await valueOf(threadItemId, "company")).toEqual([]);
      expect(await linkRows(threadItemId)).toEqual([]);
      expect(await mailThreadIdOfItemInTenant(threadItemId)).not.toBeNull();
    });
  });
});

/** The first inbound message of a thread, read through a tenant transaction. */
function firstInboundOf(threadId: string) {
  return tx((client) => firstInboundMessage(client, threadId));
}

function mailThreadIdOfItemInTenant(threadItemId: string) {
  return tx((client) => mailThreadIdOfItem(client, threadItemId));
}
