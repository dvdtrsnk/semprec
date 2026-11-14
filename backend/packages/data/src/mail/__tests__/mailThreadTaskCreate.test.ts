import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import {
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  AiGatewayFailedError,
} from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";
import { createMailThread, reassignThread } from "../mailMessageMetaStore.js";
import { getMailThreadDetail } from "../mailThreadDetail.js";
import { createMailThreadTaskCreateRouteHandler } from "../mailThreadTaskRouteHandlers.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";
import { createThreadTask, THREAD_TASK_PEOPLE_RULE_KEY } from "../threadTasks.js";

const USER = { writerKind: "user" } as const;
const USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b01";

/** A mail thread as the route names it, the Threads item its relations hang on, and the Emails item of its first message. */
interface TestThread {
  threadId: string;
  itemId: string;
  emailItemId: string;
}

let admin: Pool;
let runtime: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;
let properties: {
  threadTasks: string;
  threadProject: string;
  taskProject: string;
  taskPeople: string;
  emailFolder: string;
  emailFiles: string;
  emailSender: string;
  emailRecipients: string;
};
let inbox: { mailboxId: string; folderId: string };

const storage: BlobStorageWriter = {
  writeStream() {
    throw new Error("writeStream is not used by this test");
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

function inTenant<T>(fn: () => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, fn);
}

function databaseId(key: string): string {
  const id = databases[key];
  if (!id) throw new Error(`the ${key} database is not seeded`);
  return id;
}

async function propertyId(databaseKey: string, key: string): Promise<string> {
  const property = (await cp.listProperties(databaseId(databaseKey))).find((entry) => entry.key === key);
  if (!property) throw new Error(`the ${databaseKey}.${key} property is not seeded`);
  return property.id;
}

/** A gateway client that answers `answer` and records every call, as the port's tests of other callers do. */
function gatewayAnswering(answer: () => unknown) {
  const calls: AiGatewayCompletionInput[] = [];
  const client: AiGatewayClientPort = {
    async complete(input) {
      calls.push(input);
      return { content: await answer(), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, client };
}

function failingGateway(reason: "timeout" | "http" | "budget_exceeded" | "invalid_response") {
  return gatewayAnswering(() => {
    throw new AiGatewayFailedError(reason);
  });
}

/** A message in the inbox through the sync writer; a message that names `references` joins their thread. */
async function newMessage(messageId: string, references: string[] = [], bodyText = `body of ${messageId}`) {
  return inTenant(() =>
    withTransaction(runtime, async (client) => {
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId: databaseId("emails"),
        filesDatabaseId: databaseId("files"),
        folderRelationPropertyId: properties.emailFolder,
        attachmentsRelationPropertyId: properties.emailFiles,
        mailboxItemId: inbox.mailboxId,
        folderItemId: inbox.folderId,
        messageId,
        inReplyTo: references.at(-1) ?? null,
        references,
        subject: `Subject of ${messageId}`,
        bodyText,
        envelope: { from: { name: "Klient", address: "klient@example.test" }, to: [{ address: "me@example.test" }] },
        attachments: [],
        storage,
        storageKeyPrefix: "thread-task-create",
      });
      const { rows } = await client.query<{ id: string; item_id: string | null }>(
        `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id
          WHERE m.item_id = $1`,
        [ingested.itemId],
      );
      const row = rows[0];
      if (!row?.item_id) throw new Error("the ingested message has no thread item");
      return { threadId: row.id, itemId: row.item_id, emailItemId: ingested.itemId } satisfies TestThread;
    }),
  );
}

const newThread = (messageId: string) => newMessage(messageId);

async function newItem(databaseKey: string, itemProperties: Record<string, unknown>): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId: databaseId(databaseKey), properties: itemProperties }))).id;
}

async function link(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void> {
  await inTenant(() => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

async function unlink(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void> {
  await inTenant(() => cp.deleteRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

/** The conversation's person: a People item linked to a message of the thread the way the heartbeat action links it. */
async function addPerson(
  emailItemId: string,
  name: string,
  via: "emailSender" | "emailRecipients" = "emailSender",
): Promise<string> {
  const personId = await newItem("people", { name });
  await linkPersonToEmail(emailItemId, personId, via);
  return personId;
}

/** `Emails.senderPeople` and `Emails.recipientsPeople` belong to the `emails` process, which writes them after the sync. */
async function linkPersonToEmail(
  emailItemId: string,
  personId: string,
  via: "emailSender" | "emailRecipients",
): Promise<void> {
  await inTenant(() =>
    withTransaction(runtime, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: properties[via], callerItemId: emailItemId, targetItemId: personId },
        { ownerProcess: "emails" },
      ),
    ),
  );
}

/** Calls the route handler as the user of the tenant. */
function createTask(threadId: string, body: unknown, gateway?: AiGatewayClientPort, tenantId = tenant, locale = "cs") {
  const handler = createMailThreadTaskCreateRouteHandler(runtime, gateway ? { aiGateway: gateway } : {});
  return inTenant(() => handler({ params: { threadId }, body, identity: { user: { id: USER_ID, locale } } }), tenantId);
}

async function threadDetail(thread: TestThread) {
  return inTenant(() =>
    withTransaction(runtime, (client) => getMailThreadDetail(client, thread.threadId, false), {
      isolation: "repeatable_read",
    }),
  );
}

/** What the tenant holds that a task create adds to: Tasks items, Threads.tasks edges and value links of Tasks items. */
async function writtenState() {
  return inTenant(async () => {
    const tasks = await runtime.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
      databaseId("tasks"),
    ]);
    const edges = await runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM item_relations");
    const links = await runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM value_links");
    return { tasks: tasks.rows.map((row) => row.id), edges: edges.rows[0]?.count, links: links.rows[0]?.count };
  });
}

async function related(relationPropertyId: string, itemId: string): Promise<string[]> {
  const edges = await inTenant(() => cp.listItemRelations(itemId, relationPropertyId));
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

async function linksOf(itemId: string) {
  return (await inTenant(() => cp.getValueLinksForItems([itemId]))).get(itemId) ?? {};
}

/** Runs the queued value-link propagation jobs until none is left. */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(runtime, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: runtime, taskList: { [taskName]: handler } });
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
      [taskName],
    );
    if (rows[0]?.count === 0) return;
  }
  throw new Error("Propagation queue did not drain");
}

describe("POST /api/mail/threads/:threadId/tasks (issue gh-1900)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(runtime));
    databases = Object.fromEntries(
      (await inTenant(() => cp.listDatabases())).flatMap((database) =>
        database.ownerModuleId ? [[database.ownerModuleId, database.id]] : [],
      ),
    );
    properties = await inTenant(async () => ({
      threadTasks: await propertyId("threads", "tasks"),
      threadProject: await propertyId("threads", "project"),
      taskProject: await propertyId("tasks", "project"),
      taskPeople: await propertyId("tasks", "people"),
      emailFolder: await propertyId("emails", "folder"),
      emailFiles: await propertyId("emails", "attachments"),
      emailSender: await propertyId("emails", "senderPeople"),
      emailRecipients: await propertyId("emails", "recipientsPeople"),
    }));
    inbox = await inTenant(() =>
      withTransaction(runtime, async (client) => {
        const mailbox = await createItemWithClient(client, {
          databaseId: databaseId("mailboxes"),
          properties: { name: "Personal", provider: "generic" },
        });
        const folder = await createItemWithClient(
          client,
          {
            databaseId: databaseId("folders"),
            properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" },
          },
          { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
        );
        return { mailboxId: mailbox.id, folderId: folder.id };
      }),
    );
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("declares the link rule of the thread's project in the mail manifest", async () => {
    const registry = await loadFullModuleRegistry();
    const rules = await registry.getLinkRules();
    expect(rules.filter((rule) => rule.moduleId === "mailSync")).toEqual([
      {
        moduleId: "mailSync",
        key: "taskProjectFromThread",
        source: { databaseKey: "threads", propertyKey: "project" },
        target: { databaseKey: "tasks", propertyKey: "project" },
        via: { databaseKey: "threads", relationKey: "tasks" },
      },
      // The rule of the attachments of a thread (issue gh-1898) is declared next to it.
      {
        moduleId: "mailSync",
        key: "fileProjectFromThread",
        source: { databaseKey: "threads", propertyKey: "project" },
        target: { databaseKey: "files", propertyKey: "projects" },
        via: { databaseKey: "threads", relationKey: "attachments" },
      },
    ]);
    expect(() => registry.validateLinkRules()).not.toThrow();
  });

  it("without a name creates, in one transaction, a task named by the AI with its edge, the thread's project and the conversation's people, all inherited", async () => {
    const thread = await newMessage("<invoice@example.test>", [], "Please send the invoice for November");
    const project = await newItem("projects", { name: "Web" });
    await link(properties.threadProject, thread.itemId, project);
    const alice = await addPerson(thread.emailItemId, "Alice");
    const bob = await addPerson(thread.emailItemId, "Bob", "emailRecipients");
    const stub = gatewayAnswering(() => ({ name: '  "Send the November invoice"\n' }));
    let heldConnections = -1;
    const gateway: AiGatewayClientPort = {
      async complete(input) {
        // No transaction is open while the model works: every connection of the pool is idle.
        heldConnections = runtime.totalCount - runtime.idleCount;
        return stub.client.complete(input);
      },
    };

    const answer = await createTask(thread.threadId, {}, gateway);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.any(String), name: "Send the November invoice", date: null });
    expect(heldConnections).toBe(0);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ projectItemId: null, operation: "mail_thread_task_name" });
    expect(stub.calls[0]?.system).toContain("locale: cs");
    expect(stub.calls[0]?.messages).toEqual([
      { role: "user", content: expect.stringContaining("Please send the invoice for November") },
    ]);
    const taskId = answer.body.id;
    expect(await related(properties.threadTasks, thread.itemId)).toEqual([taskId]);
    expect(await related(properties.taskProject, taskId)).toEqual([project]);
    expect(await related(properties.taskPeople, taskId)).toEqual([alice, bob].sort());
    const threadSource = (propertyKey: string) => ({
      valueKind: "inherited",
      sources: [{ kind: "item", itemId: thread.itemId, databaseKey: "threads", propertyKey }],
      brokenBy: null,
      brokenAt: null,
    });
    const links = await linksOf(taskId);
    expect(links).toMatchObject({ project: threadSource("project"), people: threadSource("people") });
    const [shown] = (await threadDetail(thread)).tasks;
    expect(shown).toMatchObject({
      id: taskId,
      name: "Send the November invoice",
      project: { id: project, state: "active", name: "Web" },
    });
    expect(shown?.people.map((person) => person.id).sort()).toEqual([alice, bob].sort());
  });

  it("answers a task with no project and no people, and still links both properties so that a later project or person is inherited", async () => {
    const thread = await newThread("<bare@example.test>");
    const stub = gatewayAnswering(() => ({ name: "Reply to the client" }));

    const answer = await createTask(thread.threadId, {}, stub.client);

    expect(answer.status).toBe(201);
    const taskId = answer.body.id;
    expect(await related(properties.taskProject, taskId)).toEqual([]);
    expect(await related(properties.taskPeople, taskId)).toEqual([]);
    const links = await linksOf(taskId);
    expect(Object.keys(links).sort()).toEqual(["people", "project"]);
    expect(links.people).toMatchObject({ valueKind: "inherited" });
    expect(links.project).toMatchObject({ valueKind: "inherited" });
    const rows = await inTenant(() =>
      runtime.query<{ property_key: string; rule_key: string; state: string }>(
        "SELECT property_key, rule_key, state FROM value_links WHERE item_id = $1 ORDER BY property_key",
        [taskId],
      ),
    );
    expect(rows.rows).toEqual([
      { property_key: "people", rule_key: THREAD_TASK_PEOPLE_RULE_KEY, state: "on" },
      { property_key: "project", rule_key: "taskProjectFromThread", state: "on" },
    ]);
  });

  it("takes the people of every message through the sender and the recipients once, and leaves out the tenant's own person and a person in the Trash", async () => {
    const thread = await newMessage("<first@example.test>");
    const reply = await newMessage("<second@example.test>", ["<first@example.test>"]);
    expect(reply.threadId).toBe(thread.threadId);
    const alice = await addPerson(thread.emailItemId, "Alice");
    // Alice is also a recipient of the reply: one edge to her, not two.
    await linkPersonToEmail(reply.emailItemId, alice, "emailRecipients");
    const bob = await addPerson(reply.emailItemId, "Bob", "emailRecipients");
    const me = await addPerson(reply.emailItemId, "Me Myself");
    const trashed = await addPerson(thread.emailItemId, "Gone");
    // The own mailbox address is one the mailbox lists and the person's address index holds.
    await inTenant(() =>
      withTransaction(runtime, async (client) => {
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId: databaseId("mailboxes"),
          mailboxItemId: inbox.mailboxId,
          address: "me@example.test",
        });
        await reindexPersonEmails(client, me, ["Me@Example.test"]);
      }),
    );
    expect(await inTenant(() => cp.softDeleteItem(databaseId("people"), trashed))).not.toBeNull();
    const stub = gatewayAnswering(() => ({ name: "Answer the client" }));

    const answer = await createTask(thread.threadId, {}, stub.client);

    expect(await related(properties.taskPeople, answer.body.id)).toEqual([alice, bob].sort());
  });

  it("answers 409 conflict and creates no task when a message arrives between the AI call and the write", async () => {
    const thread = await newThread("<arrives@example.test>");
    const stub = gatewayAnswering(async () => {
      await newMessage("<late@example.test>", ["<arrives@example.test>"]);
      return { name: "Answer the client" };
    });

    await expect(createTask(thread.threadId, {}, stub.client)).rejects.toMatchObject({ status: 409, code: "conflict" });

    expect(stub.calls).toHaveLength(1);
    // The late message is delivered, so the counts of the edges and links are not the earlier ones: look at the task.
    expect(await writtenState()).toMatchObject({ tasks: [], links: 0 });
    expect(await related(properties.threadTasks, thread.itemId)).toEqual([]);
  });

  it("answers 409 conflict and creates no task when a message is deleted between the AI call and the write", async () => {
    const thread = await newThread("<first@example.test>");
    const second = await newMessage("<second@example.test>", ["<first@example.test>"]);
    const stub = gatewayAnswering(async () => {
      expect(await inTenant(() => cp.softDeleteItem(databaseId("emails"), second.emailItemId))).not.toBeNull();
      return { name: "Answer the client" };
    });
    const before = await writtenState();

    await expect(createTask(thread.threadId, {}, stub.client)).rejects.toMatchObject({ status: 409, code: "conflict" });

    expect(await writtenState()).toEqual(before);
  });

  it("answers 409 conflict when the thread is merged into another one between the AI call and the write", async () => {
    const thread = await newThread("<merged@example.test>");
    const target = await inTenant(() => withTransaction(runtime, (client) => createMailThread(client, "target")));
    const stub = gatewayAnswering(async () => {
      // The target has no message of its own, so the merge moves the same messages: only the thread differs.
      await inTenant(() => withTransaction(runtime, (client) => reassignThread(client, thread.threadId, target.id)));
      return { name: "Answer the client" };
    });
    const before = await writtenState();

    await expect(createTask(thread.threadId, {}, stub.client)).rejects.toMatchObject({ status: 409, code: "conflict" });

    expect(await writtenState()).toEqual(before);
  });

  it("creates the task when the thread did not change during the AI call", async () => {
    const thread = await newThread("<same@example.test>");
    const stub = gatewayAnswering(() => ({ name: "Answer the client" }));

    const answer = await createTask(thread.threadId, {}, stub.client);

    expect(answer.status).toBe(201);
    expect((await writtenState()).tasks).toEqual([answer.body.id]);
  });

  it("returns the gateway's budget error and creates no task when the tenant's budget is exhausted", async () => {
    const thread = await newThread("<budget@example.test>");
    const stub = failingGateway("budget_exceeded");
    const before = await writtenState();

    await expect(createTask(thread.threadId, {}, stub.client)).rejects.toMatchObject({
      status: 403,
      code: "budget_exceeded",
    });

    expect(stub.calls).toHaveLength(1);
    expect(await writtenState()).toEqual(before);
  });

  it.each(["timeout", "http", "invalid_response"] as const)(
    "answers 502 upstream_unavailable naming only the reason and creates no task when the gateway fails with %s",
    async (reason) => {
      const thread = await newThread(`<${reason}@example.test>`);
      const before = await writtenState();

      await expect(createTask(thread.threadId, {}, failingGateway(reason).client)).rejects.toMatchObject({
        status: 502,
        code: "upstream_unavailable",
        details: { reason },
      });

      expect(await writtenState()).toEqual(before);
    },
  );

  it.each([{ name: "" }, { name: "   " }, { other: "x" }, "text", null])(
    "treats the answer %j of the model as a gateway failure and creates no task",
    async (answer) => {
      const thread = await newThread("<unusable@example.test>");
      const before = await writtenState();

      await expect(createTask(thread.threadId, {}, gatewayAnswering(() => answer).client)).rejects.toMatchObject({
        status: 502,
        code: "upstream_unavailable",
        details: { reason: "invalid_response" },
      });

      expect(await writtenState()).toEqual(before);
    },
  );

  it("lets an error that is not the gateway's propagate unchanged and creates no task", async () => {
    const thread = await newThread("<boom@example.test>");
    const failure = new Error("the stub broke");
    const stub = gatewayAnswering(() => {
      throw failure;
    });
    const before = await writtenState();

    await expect(createTask(thread.threadId, {}, stub.client)).rejects.toBe(failure);

    expect(await writtenState()).toEqual(before);
  });

  it("cuts the AI's name to 120 characters on one line", async () => {
    const thread = await newThread("<long@example.test>");
    const stub = gatewayAnswering(() => ({ name: `${"x".repeat(130)}\nsecond line` }));

    const answer = await createTask(thread.threadId, {}, stub.client);

    expect(answer.body.name).toBe(`${"x".repeat(120)}`);
  });

  it("makes no AI call with a name and stores the name and the date", async () => {
    const thread = await newThread("<named@example.test>");
    const stub = gatewayAnswering(() => ({ name: "never used" }));

    const answer = await createTask(thread.threadId, { name: "  Pay the invoice ", date: "2026-12-01" }, stub.client);

    expect(answer).toEqual({
      status: 201,
      body: { id: expect.any(String), name: "Pay the invoice", date: "2026-12-01" },
    });
    expect(stub.calls).toEqual([]);
    const [shown] = (await threadDetail(thread)).tasks;
    expect(shown).toMatchObject({ id: answer.body.id, name: "Pay the invoice", date: "2026-12-01" });
  });

  it("asks the AI for the name only and stores the date of the request, or none without one", async () => {
    const thread = await newThread("<aidate@example.test>");
    const stub = gatewayAnswering(() => ({ name: "Send the contract" }));

    const dated = await createTask(thread.threadId, { date: "2026-12-01" }, stub.client);

    expect(dated).toEqual({
      status: 201,
      body: { id: expect.any(String), name: "Send the contract", date: "2026-12-01" },
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.system).not.toContain("2026-12-01");
    expect(stub.calls[0]?.messages[0]?.content).not.toContain("2026-12-01");

    const undated = await createTask(thread.threadId, {}, stub.client);

    expect(undated.body).toEqual({ id: expect.any(String), name: "Send the contract", date: null });
    expect(stub.calls).toHaveLength(2);
    const shown = (await threadDetail(thread)).tasks;
    expect(shown.find((task) => task.id === dated.body.id)).toMatchObject({ date: "2026-12-01" });
    expect(shown.find((task) => task.id === undated.body.id)).toMatchObject({ date: null });
  });

  it("works with a name when the composition root configured no gateway, and fails without a name with a plain configuration error", async () => {
    const thread = await newThread("<nogateway@example.test>");

    expect((await createTask(thread.threadId, { name: "Pay" })).status).toBe(201);
    const before = await writtenState();
    const failure = await createTask(thread.threadId, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty("status");
    expect(String(failure)).toContain("aiGateway");
    expect(await writtenState()).toEqual(before);
  });

  it("changes the task's project with the thread's project until the task's project is changed by hand", async () => {
    const thread = await newThread("<follow@example.test>");
    const first = await newItem("projects", { name: "First" });
    const second = await newItem("projects", { name: "Second" });
    const third = await newItem("projects", { name: "Third" });
    const fourth = await newItem("projects", { name: "Fourth" });
    await link(properties.threadProject, thread.itemId, first);
    const taskId = (await createTask(thread.threadId, { name: "Follow the thread" })).body.id;
    expect(await related(properties.taskProject, taskId)).toEqual([first]);

    await unlink(properties.threadProject, thread.itemId, first);
    await link(properties.threadProject, thread.itemId, second);
    await runPropagation();

    expect(await related(properties.taskProject, taskId)).toEqual([second]);
    expect((await linksOf(taskId)).project).toMatchObject({ valueKind: "inherited" });

    // A person replaces the task's project: the link ends, so the thread's next project does not reach the task.
    await unlink(properties.taskProject, taskId, second);
    await link(properties.taskProject, taskId, third);
    expect((await linksOf(taskId)).project).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
    await unlink(properties.threadProject, thread.itemId, second);
    await link(properties.threadProject, thread.itemId, fourth);
    await runPropagation();

    expect(await related(properties.taskProject, taskId)).toEqual([third]);
  });

  it("never meets a thread with two projects: the thread refuses a second project, so the task takes the one project of its thread", async () => {
    const thread = await newThread("<two-projects@example.test>");
    const first = await newItem("projects", { name: "First" });
    const second = await newItem("projects", { name: "Second" });
    await link(properties.threadProject, thread.itemId, first);

    await expect(link(properties.threadProject, thread.itemId, second)).rejects.toMatchObject({
      message: "Thread already has a different value",
    });

    const taskId = (await createTask(thread.threadId, { name: "One project" })).body.id;
    expect(await related(properties.taskProject, taskId)).toEqual([first]);
    expect((await linksOf(taskId)).project).toMatchObject({ valueKind: "inherited" });
  });

  it("refuses to relink the people link of a thread task, keeps the task's people and keeps the link ended", async () => {
    const thread = await newMessage("<relink@example.test>");
    const alice = await addPerson(thread.emailItemId, "Alice");
    const bob = await newItem("people", { name: "Bob" });
    const taskId = (await createTask(thread.threadId, { name: "Relink the people" })).body.id;
    expect(await related(properties.taskPeople, taskId)).toEqual([alice]);
    // The user replaces the people by hand: the link ends and the task's people are the user's.
    await unlink(properties.taskPeople, taskId, alice);
    await link(properties.taskPeople, taskId, bob);
    expect((await linksOf(taskId)).people).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });

    await expect(inTenant(() => cp.relinkValue({ itemId: taskId, propertyKey: "people" }))).rejects.toMatchObject({
      status: 409,
      code: "value_link_conflict",
    });

    expect(await related(properties.taskPeople, taskId)).toEqual([bob]);
    expect((await linksOf(taskId)).people).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
  });

  it("ends the people link of a thread task when a user unlinks it, and keeps the people", async () => {
    const thread = await newMessage("<unlink@example.test>");
    const alice = await addPerson(thread.emailItemId, "Alice");
    const taskId = (await createTask(thread.threadId, { name: "Unlink the people" })).body.id;

    await inTenant(() => cp.unlinkValue({ itemId: taskId, propertyKey: "people" }, "user"));

    expect(await related(properties.taskPeople, taskId)).toEqual([alice]);
    expect((await linksOf(taskId)).people).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
  });

  it("rolls the whole task back when a later write of the same transaction fails", async () => {
    const thread = await newThread("<rollback@example.test>");
    const project = await newItem("projects", { name: "Web" });
    await link(properties.threadProject, thread.itemId, project);
    const before = await writtenState();
    // The people link is the last row the transaction writes: refuse it, after the task, its edge and its project link.
    await admin.query(
      "CREATE FUNCTION test_refuse_people_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.property_key = 'people' THEN RAISE EXCEPTION 'refused by the test'; END IF; RETURN NEW; END $$",
    );
    await admin.query(
      "CREATE TRIGGER test_refuse_people_link BEFORE INSERT ON value_links FOR EACH ROW EXECUTE FUNCTION test_refuse_people_link()",
    );
    try {
      await expect(createTask(thread.threadId, { name: "Follow" })).rejects.toThrow("refused by the test");
    } finally {
      await admin.query("DROP TRIGGER test_refuse_people_link ON value_links");
      await admin.query("DROP FUNCTION test_refuse_people_link()");
    }

    expect(await writtenState()).toEqual(before);
    expect(await related(properties.threadTasks, thread.itemId)).toEqual([]);
  });

  it("answers an unknown thread id and another tenant's thread id with the same 404 and calls no model, writes nothing", async () => {
    const thread = await newThread("<mine@example.test>");
    const foreign = await createTestTenant(admin);
    await inTenant(() => seedSystem(runtime), foreign);
    const stub = gatewayAnswering(() => ({ name: "never" }));
    const before = await writtenState();
    const unknownId = "5f0f5a0e-1c0a-4f6e-9f55-0c2d3a1b7e11";

    const answers = [];
    for (const id of [thread.threadId, unknownId]) {
      for (const body of [{}, { name: "Named" }]) {
        answers.push(await createTask(id, body, stub.client, foreign).catch((error: unknown) => error));
      }
    }

    for (const answer of answers) expect(answer).toMatchObject({ status: 404, code: "not_found" });
    expect(new Set(answers.map((answer) => (answer instanceof Error ? answer.message : "")))).toEqual(
      new Set(["Thread not found"]),
    );
    expect(stub.calls).toEqual([]);
    expect(await writtenState()).toEqual(before);
    // The owner's own request still works, so the refusals above are real.
    expect((await createTask(thread.threadId, { name: "Mine" }, stub.client)).status).toBe(201);
  });

  it("answers 404 for a thread without a live message when no name is given, but creates the named task", async () => {
    const empty = await inTenant(() => withTransaction(runtime, (client) => createMailThread(client, "empty")));
    const stub = gatewayAnswering(() => ({ name: "never" }));

    await expect(createTask(empty.id, {}, stub.client)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(stub.calls).toEqual([]);

    expect((await createTask(empty.id, { name: "Named" }, stub.client)).status).toBe(201);
  });

  it("answers a merged-away thread id like the thread it was merged into", async () => {
    const left = await newThread("<left@example.test>");
    const right = await newMessage("<right@example.test>");
    await inTenant(() => withTransaction(runtime, (client) => reassignThread(client, left.threadId, right.threadId)));
    const stub = gatewayAnswering(() => ({ name: "Join the threads" }));

    const answer = await createTask(left.threadId, {}, stub.client);

    expect(answer.status).toBe(201);
    expect(await related(properties.threadTasks, right.itemId)).toEqual([answer.body.id]);
  });

  it.each([
    ["a threadId that is no UUID", "not-a-uuid", {}, "threadId"],
    ["an empty name", "ok", { name: "" }, "name"],
    ["a blank name", "ok", { name: "   " }, "name"],
    ["a name of 501 characters", "ok", { name: "x".repeat(501) }, "name"],
    ["a name that is no string", "ok", { name: 3 }, "name"],
    ["a name with U+0000", "ok", { name: "a\u0000b" }, "name"],
    ["a date that is no calendar date", "ok", { date: "2026-13-01" }, "date"],
    ["a date with a time", "ok", { date: "2026-12-01T10:00:00Z" }, "date"],
    ["an unknown key", "ok", { name: "x", extra: true }, "body"],
    ["a body that is null", "ok", null, "body"],
    ["a body that is an array", "ok", [], "body"],
  ] as const)("answers 400 for %s and writes nothing", async (_label, threadId, body, field) => {
    const thread = await newThread("<invalid@example.test>");
    const stub = gatewayAnswering(() => ({ name: "never" }));
    const before = await writtenState();

    await expect(createTask(threadId === "ok" ? thread.threadId : threadId, body, stub.client)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field },
    });

    expect(stub.calls).toEqual([]);
    expect(await writtenState()).toEqual(before);
  });

  it("accepts a name of exactly 500 characters", async () => {
    const thread = await newThread("<limit@example.test>");

    const answer = await createTask(thread.threadId, { name: "x".repeat(500) });

    expect(answer.body.name).toHaveLength(500);
  });

  describe("createThreadTask", () => {
    const create = (threadItemId: string) =>
      inTenant(() =>
        withTransaction(runtime, (client) =>
          createThreadTask(client, { threadItemId, name: "From a proposal" }, { writer: USER, actingUserId: USER_ID }),
        ),
      );

    it("creates the task of a Threads item for the writer it is given", async () => {
      const thread = await inTenant(() =>
        withTransaction(runtime, async (client) => {
          const created = await createMailThread(client, "proposal");
          const { rows } = await client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
            created.id,
          ]);
          return rows[0]?.item_id;
        }),
      );
      if (!thread) throw new Error("the thread has no item");

      const task = await create(thread);

      expect(task.properties.name).toBe("From a proposal");
      expect(task.databaseId).toBe(databaseId("tasks"));
    });

    it("throws not found for an item that is no Threads item, a Threads item in the Trash and a Threads item without a mail thread", async () => {
      const person = await newItem("people", { name: "Not a thread" });
      await expect(create(person)).rejects.toMatchObject({ status: 404, code: "not_found" });

      const unbacked = await inTenant(() =>
        withTransaction(runtime, async (client) => {
          const created = await createItemWithClient(
            client,
            { databaseId: databaseId("threads"), properties: { name: "No mail thread" } },
            { allowedSystemKeys: ["name"] },
          );
          return created.id;
        }),
      );
      await expect(create(unbacked)).rejects.toMatchObject({ status: 404, code: "not_found" });

      const trashed = await inTenant(() =>
        withTransaction(runtime, async (client) => {
          const created = await createMailThread(client, "trashed");
          const { rows } = await client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
            created.id,
          ]);
          return rows[0]?.item_id;
        }),
      );
      if (!trashed) throw new Error("the thread has no item");
      expect(await inTenant(() => cp.softDeleteItem(databaseId("threads"), trashed))).not.toBeNull();
      await expect(create(trashed)).rejects.toMatchObject({ status: 404, code: "not_found" });
      expect((await writtenState()).tasks).toEqual([]);
    });
  });
});
