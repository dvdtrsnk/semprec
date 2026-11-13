import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { insertValueLink } from "../../chokePoint/valueLinksStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import { getMailThreadDetail } from "../mailThreadDetail.js";
import { createMailThreadDetailRouteHandler } from "../mailThreadRoutes.js";

/** The writer of a person's own request: a relation write as this writer ends a value link, a system write does not. */
const USER = { writerKind: "user" } as const;

/** A mail thread as the route names it, and the Threads item its relations hang on. */
interface TestThread {
  threadId: string;
  itemId: string;
}

let admin: Pool;
let runtime: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;
let properties: {
  threadTasks: string;
  taskProject: string;
  taskPeople: string;
  emailFolder: string;
  emailFiles: string;
};
let inbox: { mailboxId: string; folderId: string };

/** No message of this file has an attachment, so nothing is ever written. */
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

async function propertyId(databaseKey: string, key: string): Promise<string> {
  const databaseId = databases[databaseKey];
  if (!databaseId) throw new Error(`the ${databaseKey} database is not seeded`);
  const property = (await cp.listProperties(databaseId)).find((entry) => entry.key === key);
  if (!property) throw new Error(`the ${databaseKey}.${key} property is not seeded`);
  return property.id;
}

function databaseId(key: string): string {
  const id = databases[key];
  if (!id) throw new Error(`the ${key} database is not seeded`);
  return id;
}

/**
 * The thread of one live message, through the sync writer; the detail answers 404 for a thread without one.
 * A message with `references` joins the thread of the messages it names, and merges their threads when they differ.
 */
async function newThread(messageId: string, references: string[] = []): Promise<TestThread> {
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
        subject: messageId,
        envelope: { from: { address: "klient@example.test" }, to: [{ address: "me@example.test" }] },
        attachments: [],
        storage,
        storageKeyPrefix: "thread-tasks",
      });
      const { rows } = await client.query<{ id: string; item_id: string | null }>(
        `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id
          WHERE m.item_id = $1`,
        [ingested.itemId],
      );
      const row = rows[0];
      if (!row?.item_id) throw new Error("the ingested message has no thread item");
      return { threadId: row.id, itemId: row.item_id };
    }),
  );
}

async function newItem(databaseKey: string, itemProperties: Record<string, unknown>): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId: databaseId(databaseKey), properties: itemProperties }))).id;
}

/** Links through the choke point as a user, as a person's own request does. */
async function link(relationPropertyId: string, callerItemId: string, targetItemId: string): Promise<void> {
  await inTenant(() => cp.createRelation({ relationPropertyId, callerItemId, targetItemId }, USER));
}

/** A task linked to `thread` through `Threads.tasks`. */
async function newThreadTask(thread: TestThread, taskProperties: Record<string, unknown>): Promise<string> {
  const taskId = await newItem("tasks", taskProperties);
  await link(properties.threadTasks, thread.itemId, taskId);
  return taskId;
}

/**
 * An `on` value link of one task property whose source is the thread item. No link rule makes a task
 * inherit from its thread, so the row is written with the store function the link rules write theirs with.
 */
async function inherit(taskId: string, propertyKey: string, thread: TestThread): Promise<void> {
  await inTenant(() =>
    withTransaction(runtime, (client) =>
      insertValueLink(client, {
        itemId: taskId,
        propertyKey,
        ruleKey: "test.threadTask",
        sources: [{ kind: "item", sourceItemId: thread.itemId, sourcePropertyKey: propertyKey }],
      }),
    ),
  );
}

async function tasksOf(thread: TestThread, tenantId = tenant) {
  return inTenant(
    () => withTransaction(runtime, async (client) => (await getMailThreadDetail(client, thread.threadId, false)).tasks),
    tenantId,
  );
}

describe("tasks of GET /api/mail/threads/:threadId (issue gh-1692)", () => {
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
      taskProject: await propertyId("tasks", "project"),
      taskPeople: await propertyId("tasks", "people"),
      emailFolder: await propertyId("emails", "folder"),
      emailFiles: await propertyId("emails", "attachments"),
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

  it("returns exactly the tasks linked to the thread, with project, people and the link state of those two properties", async () => {
    const thread = await newThread("<invoice@example.test>");
    const otherThread = await newThread("<other@example.test>");
    const project = await newItem("projects", { name: "Web" });
    const alice = await newItem("people", { name: "Alice" });
    const bob = await newItem("people", { name: "Bob" });
    const full = await newThreadTask(thread, { name: "Send the invoice", date: "2026-11-20", status: "notDone" });
    await link(properties.taskProject, full, project);
    // Linked in the opposite order of their names: the response orders people by name.
    await link(properties.taskPeople, full, bob);
    await link(properties.taskPeople, full, alice);
    const bare = await newThreadTask(thread, { name: "Call back", status: "done" });
    const ofOtherThread = await newThreadTask(otherThread, { name: "Other thread's task" });
    const sameProjectNoEdge = await newItem("tasks", { name: "Same project, no thread" });
    await link(properties.taskProject, sameProjectNoEdge, project);
    const trashed = await newThreadTask(thread, { name: "Trashed" });
    expect(await inTenant(() => cp.softDeleteItem(databaseId("tasks"), trashed))).not.toBeNull();
    // The links are written after the user edits above, which would otherwise end them.
    await inherit(full, "project", thread);
    await inherit(full, "people", thread);
    // A link of a property the detail does not report.
    await inherit(full, "date", thread);

    const tasks = await tasksOf(thread);

    const threadSource = (propertyKey: string) => ({
      valueKind: "inherited",
      sources: [
        { kind: "item", itemId: thread.itemId, databaseKey: "threads", title: "<invoice@example.test>", propertyKey },
      ],
      brokenBy: null,
      brokenAt: null,
    });
    expect(tasks).toEqual([
      {
        id: full,
        name: "Send the invoice",
        date: "2026-11-20",
        status: "notDone",
        project: { id: project, state: "active", name: "Web" },
        people: [
          { id: alice, state: "active", name: "Alice" },
          { id: bob, state: "active", name: "Bob" },
        ],
        links: { project: threadSource("project"), people: threadSource("people") },
      },
      { id: bare, name: "Call back", date: null, status: "done", project: null, people: [], links: {} },
    ]);
    const listed = tasks.map((task) => task.id);
    for (const absent of [ofOtherThread, sameProjectNoEdge, trashed]) expect(listed).not.toContain(absent);
    expect((await tasksOf(otherThread)).map((task) => task.id)).toEqual([ofOtherThread]);
  });

  it("answers the tasks through the route handler, and an empty list for a thread without tasks", async () => {
    const thread = await newThread("<invoice@example.test>");
    const empty = await newThread("<empty@example.test>");
    const task = await newThreadTask(thread, { name: "Send the invoice" });
    const handler = createMailThreadDetailRouteHandler(runtime);
    const answer = (threadId: string) =>
      inTenant(() => handler({ req: { url: `/api/mail/threads/${threadId}` }, params: { threadId } }));

    const withTask = await answer(thread.threadId);
    expect(withTask.status).toBe(200);
    expect(withTask.body.tasks.map((entry) => entry.id)).toEqual([task]);
    expect((await answer(empty.threadId)).body.tasks).toEqual([]);
  });

  it("puts not-done tasks first, then orders by date with undated tasks last, then by creation time", async () => {
    const thread = await newThread("<invoice@example.test>");
    const done = await newThreadTask(thread, { name: "done, earliest date", status: "done", date: "2026-01-01" });
    const later = await newThreadTask(thread, { name: "open, later date", status: "notDone", date: "2026-03-01" });
    const sooner = await newThreadTask(thread, { name: "open, sooner date", status: "notDone", date: "2026-02-01" });
    const undatedFirst = await newThreadTask(thread, { name: "open, undated, created first", status: "notDone" });
    const undatedSecond = await newThreadTask(thread, { name: "open, undated, created second", status: "notDone" });
    const wontDo = await newThreadTask(thread, { name: "won't do", status: "wontDo", date: "2026-01-15" });

    const tasks = await tasksOf(thread);

    expect(tasks.map((task) => task.id)).toEqual([sooner, later, undatedFirst, undatedSecond, done, wontDo]);
    expect(tasks.map((task) => task.status)).toEqual(["notDone", "notDone", "notDone", "notDone", "done", "wontDo"]);
    for (const task of tasks) expect(typeof task.status).toBe("string");
  });

  it("shows inheritedBroken for people once a person changed them by hand", async () => {
    const thread = await newThread("<invoice@example.test>");
    const alice = await newItem("people", { name: "Alice" });
    const bob = await newItem("people", { name: "Bob" });
    const task = await newThreadTask(thread, { name: "Send the invoice" });
    await link(properties.taskPeople, task, alice);
    await inherit(task, "people", thread);
    expect((await tasksOf(thread))[0]?.links).toMatchObject({ people: { valueKind: "inherited", brokenBy: null } });

    await link(properties.taskPeople, task, bob);

    const [changed] = await tasksOf(thread);
    expect(changed?.people.map((person) => person.id)).toEqual([alice, bob]);
    expect(changed?.links.people).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
    expect(changed?.links.people?.brokenAt).toEqual(expect.any(String));
    expect(changed?.links.project).toBeUndefined();
  });

  it("lists a trashed project and a trashed person of a task as a trashed marker after the live ones", async () => {
    const thread = await newThread("<invoice@example.test>");
    const project = await newItem("projects", { name: "Web" });
    const alice = await newItem("people", { name: "Alice" });
    const bob = await newItem("people", { name: "Bob" });
    const carol = await newItem("people", { name: "Carol" });
    const task = await newThreadTask(thread, { name: "Send the invoice" });
    await link(properties.taskProject, task, project);
    // Linked in the opposite order of their names: the response orders people by name.
    await link(properties.taskPeople, task, carol);
    await link(properties.taskPeople, task, bob);
    await link(properties.taskPeople, task, alice);
    expect((await tasksOf(thread))[0]).toMatchObject({
      project: { id: project, state: "active", name: "Web" },
      people: [
        { id: alice, state: "active" },
        { id: bob, state: "active" },
        { id: carol, state: "active" },
      ],
    });

    expect(await inTenant(() => cp.softDeleteItem(databaseId("projects"), project))).not.toBeNull();
    // Alice sorts first by name, so only the order rule puts her marker after Bob and Carol.
    expect(await inTenant(() => cp.softDeleteItem(databaseId("people"), alice))).not.toBeNull();

    const [listed] = await tasksOf(thread);
    expect(listed?.id).toBe(task);
    expect(listed?.project).toEqual({ id: project, state: "trashed" });
    expect(listed?.project).not.toHaveProperty("name");
    expect(listed?.people).toEqual([
      { id: bob, state: "active", name: "Bob" },
      { id: carol, state: "active", name: "Carol" },
      { id: alice, state: "trashed" },
    ]);
  });

  it("orders the trashed people of a task by id after the live ones", async () => {
    const thread = await newThread("<invoice@example.test>");
    const task = await newThreadTask(thread, { name: "Send the invoice" });
    const live = await newItem("people", { name: "Zed" });
    const trashedIds = [
      await newItem("people", { name: "Yan" }),
      await newItem("people", { name: "Abe" }),
      await newItem("people", { name: "Mia" }),
    ];
    for (const id of [live, ...trashedIds]) await link(properties.taskPeople, task, id);
    for (const id of trashedIds)
      expect(await inTenant(() => cp.softDeleteItem(databaseId("people"), id))).not.toBeNull();

    const [listed] = await tasksOf(thread);

    expect(listed?.people).toEqual([
      { id: live, state: "active", name: "Zed" },
      ...[...trashedIds].sort().map((id) => ({ id, state: "trashed" })),
    ]);
  });

  it("answers an empty name for a task, a project and a person that have none", async () => {
    const thread = await newThread("<invoice@example.test>");
    const project = await newItem("projects", {});
    const person = await newItem("people", {});
    const task = await newThreadTask(thread, {});
    await link(properties.taskProject, task, project);
    await link(properties.taskPeople, task, person);

    expect(await tasksOf(thread)).toEqual([
      {
        id: task,
        name: "",
        date: null,
        status: "notDone",
        project: { id: project, state: "active", name: "" },
        people: [{ id: person, state: "active", name: "" }],
        links: {},
      },
    ]);
  });

  it("answers a merged-away thread id with the tasks of the thread it was merged into", async () => {
    const left = await newThread("<left@example.test>");
    const right = await newThread("<right@example.test>");
    const ofLeft = await newThreadTask(left, { name: "Left's task", date: "2026-11-01" });
    const ofRight = await newThreadTask(right, { name: "Right's task", date: "2026-11-02" });
    // A reply naming both messages joins their threads through the sync writer's threading.
    const target = await newThread("<join@example.test>", ["<left@example.test>", "<right@example.test>"]);
    const merged = [left, right].find((thread) => thread.threadId !== target.threadId);
    if (!merged) throw new Error("the reply did not merge the two threads");
    expect([left.threadId, right.threadId]).toContain(target.threadId);

    // The merge moved the merged-away thread's task to the target, so both ids answer both tasks.
    expect((await tasksOf(merged)).map((task) => task.id)).toEqual([ofLeft, ofRight]);
    expect((await tasksOf(target)).map((task) => task.id)).toEqual([ofLeft, ofRight]);
  });

  it("runs the same number of statements for one task as for five", async () => {
    async function seed(messageId: string, count: number): Promise<TestThread> {
      const thread = await newThread(messageId);
      for (let index = 0; index < count; index += 1) {
        const task = await newThreadTask(thread, { name: `Task ${index}` });
        await link(properties.taskProject, task, await newItem("projects", { name: `Project ${index}` }));
        await link(properties.taskPeople, task, await newItem("people", { name: `Person ${index}` }));
        await inherit(task, "project", thread);
        await inherit(task, "people", thread);
      }
      return thread;
    }
    async function countStatements(thread: TestThread, expectedTasks: number): Promise<number> {
      return inTenant(() =>
        withTransaction(runtime, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const detail = await getMailThreadDetail(client, thread.threadId, false);
            expect(detail.tasks).toHaveLength(expectedTasks);
            expect(detail.tasks.every((task) => task.links.project && task.links.people)).toBe(true);
            return spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }
        }),
      );
    }

    const one = await countStatements(await seed("<one@example.test>", 1), 1);
    const five = await countStatements(await seed("<five@example.test>", 5), 5);

    expect(one).toBeGreaterThan(0);
    expect(five).toBe(one);
  });

  it("shows another tenant none of the tasks: its detail of the thread id is a 404", async () => {
    const thread = await newThread("<invoice@example.test>");
    await newThreadTask(thread, { name: "Send the invoice" });
    const foreign = await createTestTenant(admin);
    await inTenant(() => seedSystem(runtime), foreign);

    await expect(tasksOf(thread, foreign)).rejects.toMatchObject({ code: "not_found" });
    expect(await tasksOf(thread)).toHaveLength(1);
  });
});
