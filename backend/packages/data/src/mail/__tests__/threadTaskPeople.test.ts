import "../../domainWriteHooks.js";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "../../chokePoint/relationOps.js";
import { insertValueLink } from "../../chokePoint/valueLinksStore.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { mergeModuleTaskListForAffinity } from "../../moduleTasks.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";
import {
  handleMailSyncThreadTaskPeople,
  MAIL_SYNC_THREAD_TASK_PEOPLE_TASK,
  setThreadTaskPeopleDelivery,
  threadTaskPeopleEdgeChangedHook,
} from "../threadTaskPeople.js";
import { createThreadTask } from "../threadTasks.js";

const USER = { writerKind: "user" } as const;
const EMAILS_PROCESS = { ownerProcess: "emails" } as const;
const TASK = MAIL_SYNC_THREAD_TASK_PEOPLE_TASK;

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
  taskPeople: string;
  emailFolder: string;
  emailFiles: string;
  emailSender: string;
  emailRecipients: string;
};
let inbox: { mailboxId: string; folderId: string };
let invalidations: InvalidationEvent[];

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

/** A message in the inbox through the sync writer; a message that names `references` joins their thread. */
async function newMessage(messageId: string, references: string[] = []): Promise<TestThread> {
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
        bodyText: `body of ${messageId}`,
        envelope: { from: { name: "Klient", address: "klient@example.test" }, to: [{ address: "me@example.test" }] },
        attachments: [],
        storage,
        storageKeyPrefix: "thread-task-people",
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

async function newPerson(name: string): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId: databaseId("people"), properties: { name } }))).id;
}

type Via = "emailSender" | "emailRecipients";

/** `Emails.senderPeople` and `Emails.recipientsPeople` belong to the `emails` process, which writes them after the sync. */
async function linkPersonToEmail(emailItemId: string, personId: string, via: Via = "emailSender"): Promise<void> {
  await inTenant(() =>
    withTransaction(runtime, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: properties[via], callerItemId: emailItemId, targetItemId: personId },
        EMAILS_PROCESS,
      ),
    ),
  );
}

async function addPerson(emailItemId: string, name: string, via: Via = "emailSender"): Promise<string> {
  const personId = await newPerson(name);
  await linkPersonToEmail(emailItemId, personId, via);
  return personId;
}

/** A task made from the thread the way the route makes it: through `createThreadTask`. */
async function newThreadTask(thread: TestThread, name = "Answer the client"): Promise<string> {
  const task = await inTenant(() =>
    withTransaction(runtime, (client) =>
      createThreadTask(client, { threadItemId: thread.itemId, name }, { writer: USER }),
    ),
  );
  return task.id;
}

async function related(relationPropertyId: string, itemId: string): Promise<string[]> {
  const edges = await inTenant(() => cp.listItemRelations(itemId, relationPropertyId));
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

async function peopleOf(taskId: string): Promise<string[]> {
  return related(properties.taskPeople, taskId);
}

async function peopleLinkKind(taskId: string): Promise<string | undefined> {
  const links = (await inTenant(() => cp.getValueLinksForItems([taskId]))).get(taskId);
  return links?.people?.valueKind;
}

const jobPayload = z.object({
  tenantId: z.uuid().nullable(),
  payload: z.object({ threadItemId: z.uuid(), personId: z.uuid() }),
});

/** The envelopes of the queued jobs of the task, as the queue stores them, in person id order. */
async function queuedJobs() {
  return (await readJobPayloadsByIdentifier(admin, TASK))
    .map((payload) => jobPayload.parse(payload))
    .sort((left, right) => left.payload.personId.localeCompare(right.payload.personId));
}

/** The keys of the queued jobs of the task. */
async function queuedJobKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [TASK],
  );
  return rows.map((row) => row.key ?? "");
}

/** The jobs of the task still in the queue, with the error of their last attempt. */
async function leftoverJobs() {
  const { rows } = await admin.query<{ key: string | null; attempts: number; last_error: string | null }>(
    "SELECT key, attempts, last_error FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [TASK],
  );
  return rows;
}

/**
 * Runs the queued jobs of the task with the handler the module registry resolves for it, on the runtime pool, until
 * none is left: the jobs of one tenant share a queue lane, which one pass of the runner takes one job of at a time.
 * A job that failed stays in the queue and is reported by the assertion.
 */
async function runJobs(): Promise<void> {
  const taskList = await mergeModuleTaskListForAffinity({}, await loadFullModuleRegistry(), "api");
  const handler = taskList[TASK];
  if (!handler) throw new Error("The api task list has no mailSyncThreadTaskPeople handler");
  for (let pass = 0; pass < 10 && (await leftoverJobs()).length > 0; pass += 1) {
    await runOnce({ pgPool: runtime }, { [TASK]: handler });
  }
  expect(await leftoverJobs()).toEqual([]);
}

/** Queues the job for `personId` on `threadItemId` as another producer would, in the tenant's scope. */
async function enqueueSync(threadItemId: string, personId: string, tenantId = tenant): Promise<void> {
  await inTenant(
    () => withTransaction(runtime, (client) => enqueueJob(client, TASK, { threadItemId, personId })),
    tenantId,
  );
}

function itemInvalidationsOf(itemId: string) {
  return invalidations.flatMap((event) => (event.scope === "item" && event.itemId === itemId ? [event] : []));
}

describe("the people of a thread's tasks follow the conversation (issue gh-1923)", () => {
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
    setThreadTaskPeopleDelivery({ pool: runtime });
    invalidations = [];
    setInvalidationHook((event) => invalidations.push(event));
  });

  afterEach(() => {
    setThreadTaskPeopleDelivery(null);
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("is declared in the mail manifest as a module task of the api queue", async () => {
    const tasks = (await (await loadFullModuleRegistry()).getTasks()).filter((task) => task.moduleId === "mailSync");
    // The mail module declares more than this task (`mailTriageThreadProject`, issue gh-1872), so look for this one.
    expect(tasks).toContainEqual(expect.objectContaining({ name: TASK, queueAffinity: "api" }));
  });

  describe("the edge changed hook", () => {
    it("queues one job for the thread and the person when a sender edge is added, in the edge's transaction, keyed by tenant, thread and person", async () => {
      const thread = await newMessage("<sender@example.test>");
      const alice = await newPerson("Alice");

      await linkPersonToEmail(thread.emailItemId, alice);

      expect(await queuedJobKeys()).toEqual([`${TASK}:${tenant}:${thread.itemId}:${alice}`]);
      expect(await queuedJobs()).toEqual([
        { tenantId: tenant, payload: { threadItemId: thread.itemId, personId: alice } },
      ]);
    });

    it("queues a job for a recipient edge as well", async () => {
      const thread = await newMessage("<recipient@example.test>");
      const bob = await newPerson("Bob");

      await linkPersonToEmail(thread.emailItemId, bob, "emailRecipients");

      expect((await queuedJobs()).map((job) => job.payload)).toEqual([{ threadItemId: thread.itemId, personId: bob }]);
    });

    it("queues one job per person, so two people who join one thread are both kept", async () => {
      const thread = await newMessage("<two@example.test>");
      const alice = await addPerson(thread.emailItemId, "Alice");
      const bob = await addPerson(thread.emailItemId, "Bob", "emailRecipients");

      expect((await queuedJobs()).map((job) => job.payload.personId).sort()).toEqual([alice, bob].sort());
    });

    it("queues the same job once when the same edge is written again", async () => {
      const thread = await newMessage("<again@example.test>");
      const alice = await addPerson(thread.emailItemId, "Alice");

      await linkPersonToEmail(thread.emailItemId, alice);

      expect(await queuedJobs()).toHaveLength(1);
    });

    it("queues nothing when the writing transaction rolls back", async () => {
      const thread = await newMessage("<rollback@example.test>");
      const alice = await newPerson("Alice");

      await expect(
        inTenant(() =>
          withTransaction(runtime, async (client) => {
            await createRelationWithClient(
              client,
              { relationPropertyId: properties.emailSender, callerItemId: thread.emailItemId, targetItemId: alice },
              EMAILS_PROCESS,
            );
            throw new Error("rolled back on purpose");
          }),
        ),
      ).rejects.toThrow("rolled back on purpose");

      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing for an update or a delete of the edge", async () => {
      const thread = await newMessage("<update@example.test>");
      const alice = await addPerson(thread.emailItemId, "Alice");
      await runJobs();

      await inTenant(() =>
        withTransaction(runtime, async (client) => {
          await updateRelationWithClient(
            client,
            {
              relationPropertyId: properties.emailSender,
              callerItemId: thread.emailItemId,
              targetItemId: alice,
              metadata: {},
            },
            EMAILS_PROCESS,
          );
          await deleteRelationWithClient(
            client,
            { relationPropertyId: properties.emailSender, callerItemId: thread.emailItemId, targetItemId: alice },
            EMAILS_PROCESS,
          );
        }),
      );

      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing for an edge of another property", async () => {
      const thread = await newMessage("<other@example.test>");
      const task = await newThreadTask(thread);
      const carol = await newPerson("Carol");
      await runJobs();

      // `Threads.tasks` and `Tasks.people` are relations of the same modules that are not a message people relation.
      await inTenant(() =>
        cp.createRelation({ relationPropertyId: properties.taskPeople, callerItemId: task, targetItemId: carol }, USER),
      );
      const other = await inTenant(() =>
        cp.createItem({ databaseId: databaseId("tasks"), properties: { name: "Other" } }),
      );
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: properties.threadTasks, callerItemId: thread.itemId, targetItemId: other.id },
          USER,
        ),
      );

      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing for a message that has no thread", async () => {
      const unthreaded = await inTenant(() =>
        withTransaction(runtime, (client) =>
          createItemWithClient(
            client,
            { databaseId: databaseId("emails"), properties: { name: "Not threaded" } },
            { allowedSystemKeys: ["name"] },
          ),
        ),
      );
      const alice = await newPerson("Alice");

      await linkPersonToEmail(unthreaded.id, alice);

      expect(await queuedJobs()).toEqual([]);
    });

    it("refuses to queue outside a tenant scope and queues nothing", async () => {
      const queries: string[] = [];
      const answers: Array<{ rows: Array<Record<string, unknown>> }> = [
        { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] },
        { rows: [{ item_id: "00000000-0000-4000-8000-000000000002" }] },
      ];
      // A scripted client: the hook asks for the relation, then for the thread, then must stop at the scope check
      // before it sends the job to the queue. Casting the stub is not a boundary: it is this test's own object.
      const client = {
        async query(sql: string) {
          queries.push(sql);
          return answers.shift() ?? { rows: [] };
        },
      } as unknown as PoolClient;

      await expect(
        runAsSystem("test: a hook outside a tenant scope", () =>
          threadTaskPeopleEdgeChangedHook({
            client,
            op: "create",
            relationDefinitionId: "00000000-0000-4000-8000-000000000003",
            propertyId: "00000000-0000-4000-8000-000000000004",
            itemA: "00000000-0000-4000-8000-000000000005",
            itemB: "00000000-0000-4000-8000-000000000006",
            metadata: {},
            writer: USER,
          }),
        ),
      ).rejects.toThrow(/requires a tenant scope/);

      expect(queries).toHaveLength(2);
      expect(queries.some((sql) => sql.includes("add_job"))).toBe(false);
    });
  });

  describe("the job", () => {
    it("adds a person who joins the thread to a task with inherited people, as an inherited value, and announces the task", async () => {
      const thread = await newMessage("<first@example.test>");
      const alice = await addPerson(thread.emailItemId, "Alice");
      await runJobs();
      const task = await newThreadTask(thread);
      expect(await peopleOf(task)).toEqual([alice]);
      const reply = await newMessage("<reply@example.test>", ["<first@example.test>"]);
      const bob = await addPerson(reply.emailItemId, "Bob", "emailRecipients");
      invalidations.length = 0;

      await runJobs();

      expect(await peopleOf(task)).toEqual([alice, bob].sort());
      expect(await peopleLinkKind(task)).toBe("inherited");
      expect(itemInvalidationsOf(task)).toEqual([
        expect.objectContaining({ scope: "item", databaseId: databaseId("tasks"), itemId: task, op: "update" }),
      ]);
    });

    it("adds the person to every task of the thread whose people are still inherited and skips one whose people were changed by hand", async () => {
      const thread = await newMessage("<many@example.test>");
      await runJobs();
      const following = await newThreadTask(thread, "Following");
      const alsoFollowing = await newThreadTask(thread, "Also following");
      const changed = await newThreadTask(thread, "Changed by hand");
      const carol = await newPerson("Carol");
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: properties.taskPeople, callerItemId: changed, targetItemId: carol },
          USER,
        ),
      );
      expect(await peopleLinkKind(changed)).toBe("inheritedBroken");
      const bob = await addPerson(thread.emailItemId, "Bob");
      invalidations.length = 0;

      await runJobs();

      expect(await peopleOf(following)).toEqual([bob]);
      expect(await peopleOf(alsoFollowing)).toEqual([bob]);
      expect(await peopleOf(changed)).toEqual([carol]);
      expect(itemInvalidationsOf(changed)).toEqual([]);
    });

    it("does not add the person when the task's people were changed by hand by adding someone", async () => {
      const thread = await newMessage("<hand-add@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const carol = await newPerson("Carol");
      await inTenant(() =>
        cp.createRelation({ relationPropertyId: properties.taskPeople, callerItemId: task, targetItemId: carol }, USER),
      );
      await addPerson(thread.emailItemId, "Bob");

      await runJobs();

      expect(await peopleOf(task)).toEqual([carol]);
      expect(await peopleLinkKind(task)).toBe("inheritedBroken");
    });

    it("does not add the person when the task's people were changed by hand by removing someone", async () => {
      const thread = await newMessage("<hand-remove@example.test>");
      const alice = await addPerson(thread.emailItemId, "Alice");
      await runJobs();
      const task = await newThreadTask(thread);
      await inTenant(() =>
        cp.deleteRelation({ relationPropertyId: properties.taskPeople, callerItemId: task, targetItemId: alice }, USER),
      );
      await addPerson(thread.emailItemId, "Bob");

      await runJobs();

      expect(await peopleOf(task)).toEqual([]);
      expect(await peopleLinkKind(task)).toBe("inheritedBroken");
    });

    it("does not add a person for the tenant's own mailbox address", async () => {
      const thread = await newMessage("<own@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const me = await addPerson(thread.emailItemId, "Me Myself");
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
      const bob = await addPerson(thread.emailItemId, "Bob");
      invalidations.length = 0;

      await runJobs();

      expect(await peopleOf(task)).toEqual([bob]);
      expect(itemInvalidationsOf(task)).toHaveLength(1);
    });

    it("leaves the people unchanged when the job runs twice for the same person", async () => {
      const thread = await newMessage("<twice@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const bob = await addPerson(thread.emailItemId, "Bob");
      await runJobs();
      invalidations.length = 0;

      await enqueueSync(thread.itemId, bob);
      await runJobs();

      expect(await peopleOf(task)).toEqual([bob]);
      expect(await peopleLinkKind(task)).toBe("inherited");
      expect(itemInvalidationsOf(task)).toEqual([]);
    });

    it("leaves a task in the Trash alone", async () => {
      const thread = await newMessage("<trashed-task@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      expect(await inTenant(() => cp.softDeleteItem(databaseId("tasks"), task))).not.toBeNull();
      await addPerson(thread.emailItemId, "Bob");

      await runJobs();

      expect(await peopleOf(task)).toEqual([]);
    });

    it("leaves a task without a people link alone", async () => {
      const thread = await newMessage("<no-link@example.test>");
      await runJobs();
      const plain = await inTenant(() =>
        cp.createItem({ databaseId: databaseId("tasks"), properties: { name: "Plain" } }),
      );
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: properties.threadTasks, callerItemId: thread.itemId, targetItemId: plain.id },
          USER,
        ),
      );
      await addPerson(thread.emailItemId, "Bob");

      await runJobs();

      expect(await peopleOf(plain.id)).toEqual([]);
      expect(await peopleLinkKind(plain.id)).toBeUndefined();
    });

    it("leaves alone a task whose live people link belongs to another rule, even though it names this thread as a source", async () => {
      const thread = await newMessage("<other-rule@example.test>");
      await runJobs();
      const own = await newThreadTask(thread);
      // A task of the thread whose people link is on and names the thread, but another rule owns the link.
      const guarded = await inTenant(() =>
        cp.createItem({ databaseId: databaseId("tasks"), properties: { name: "Another rule" } }),
      );
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: properties.threadTasks, callerItemId: thread.itemId, targetItemId: guarded.id },
          USER,
        ),
      );
      await inTenant(() =>
        withTransaction(runtime, (client) =>
          insertValueLink(client, {
            itemId: guarded.id,
            propertyKey: "people",
            ruleKey: "otherRule",
            sources: [{ kind: "item", sourceItemId: thread.itemId, sourcePropertyKey: "people" }],
          }),
        ),
      );
      const bob = await addPerson(thread.emailItemId, "Bob");
      invalidations = [];

      await runJobs();

      expect(await peopleOf(guarded.id)).toEqual([]);
      expect(await peopleLinkKind(guarded.id)).toBe("inherited");
      expect(itemInvalidationsOf(guarded.id)).toEqual([]);
      // The guard skips only the task of the other rule: the task of the thread's own rule still gets the person.
      expect(await peopleOf(own)).toEqual([bob]);
      expect(itemInvalidationsOf(own)).toHaveLength(1);
    });

    it("leaves alone a task whose people link names another thread than the one the task hangs under", async () => {
      const first = await newMessage("<thread-a@example.test>");
      const second = await newMessage("<thread-b@example.test>");
      expect(second.itemId).not.toBe(first.itemId);
      await runJobs();
      const task = await newThreadTask(first);
      // A task has one thread (`Threads.tasks` is one-to-many): the edge moves to the second thread, and the people link
      // keeps naming the first.
      await inTenant(() =>
        cp.deleteRelation(
          { relationPropertyId: properties.threadTasks, callerItemId: first.itemId, targetItemId: task },
          USER,
        ),
      );
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: properties.threadTasks, callerItemId: second.itemId, targetItemId: task },
          USER,
        ),
      );
      await addPerson(second.emailItemId, "From the second");

      await runJobs();

      expect(await peopleOf(task)).toEqual([]);
      expect(await peopleLinkKind(task)).toBe("inherited");
    });

    it("does not add a person whose only message left the conversation", async () => {
      const thread = await newMessage("<kept@example.test>");
      const reply = await newMessage("<gone@example.test>", ["<kept@example.test>"]);
      await runJobs();
      const task = await newThreadTask(thread);
      await addPerson(reply.emailItemId, "Bob");
      expect(await inTenant(() => cp.softDeleteItem(databaseId("emails"), reply.emailItemId))).not.toBeNull();

      await runJobs();

      expect(await peopleOf(task)).toEqual([]);
    });

    it("does not add a person who is in the Trash", async () => {
      const thread = await newMessage("<trashed-person@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const bob = await addPerson(thread.emailItemId, "Bob");
      expect(await inTenant(() => cp.softDeleteItem(databaseId("people"), bob))).not.toBeNull();

      await runJobs();

      expect(await peopleOf(task)).toEqual([]);
    });

    it("never removes a person: a removed edge leaves the task's people as they are", async () => {
      const thread = await newMessage("<removal@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const bob = await addPerson(thread.emailItemId, "Bob");
      await runJobs();
      await inTenant(() =>
        withTransaction(runtime, (client) =>
          deleteRelationWithClient(
            client,
            { relationPropertyId: properties.emailSender, callerItemId: thread.emailItemId, targetItemId: bob },
            EMAILS_PROCESS,
          ),
        ),
      );
      await runJobs();

      expect(await peopleOf(task)).toEqual([bob]);
      expect(await peopleLinkKind(task)).toBe("inherited");
    });

    it("ends without a write for a thread item that does not exist", async () => {
      const thread = await newMessage("<known@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const bob = await addPerson(thread.emailItemId, "Bob");
      await runJobs();
      await enqueueSync("00000000-0000-4000-8000-0000000000aa", bob);

      await runJobs();

      expect(await peopleOf(task)).toEqual([bob]);
    });

    it("waits for a manual change of the task's people that is still open and then leaves the person out", async () => {
      const thread = await newMessage("<race@example.test>");
      await runJobs();
      const task = await newThreadTask(thread);
      const bob = await addPerson(thread.emailItemId, "Bob");
      const carol = await newPerson("Carol");
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let edited: () => void = () => {};
      const editDone = new Promise<void>((resolve) => {
        edited = resolve;
      });

      // The manual edit adds Carol, which ends the link, and stays open until the job is seen waiting for it.
      const edit = inTenant(() =>
        withTransaction(runtime, async (client) => {
          await createRelationWithClient(
            client,
            { relationPropertyId: properties.taskPeople, callerItemId: task, targetItemId: carol },
            undefined,
            USER,
          );
          edited();
          await gate;
        }),
      );
      await editDone;
      const job = runJobs();
      const deadline = Date.now() + 15_000;
      let waiting = 0;
      while (waiting === 0 && Date.now() < deadline) {
        const { rows } = await admin.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted",
        );
        waiting = rows[0]?.waiting ?? 0;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await Promise.all([edit, job]);

      expect(waiting).toBeGreaterThan(0);
      expect(await peopleOf(task)).toEqual([carol]);
      expect(await peopleOf(task)).not.toContain(bob);
      expect(await peopleLinkKind(task)).toBe("inheritedBroken");
    });
  });

  describe("the handler", () => {
    it("fails, so that the queue retries, when the composition root bound no pool", async () => {
      setThreadTaskPeopleDelivery(null);

      await expect(
        handleMailSyncThreadTaskPeople({
          threadItemId: "00000000-0000-4000-8000-000000000001",
          personId: "00000000-0000-4000-8000-000000000002",
        }),
      ).rejects.toThrow("No thread task people delivery is configured for this composition root");
    });

    it("refuses a payload that is not exactly the thread item and the person", async () => {
      await expect(handleMailSyncThreadTaskPeople({ threadItemId: "not-a-uuid", personId: "x" })).rejects.toThrow();
      await expect(
        handleMailSyncThreadTaskPeople({
          threadItemId: "00000000-0000-4000-8000-000000000001",
          personId: "00000000-0000-4000-8000-000000000002",
          tenantId: "00000000-0000-4000-8000-000000000003",
        }),
      ).rejects.toThrow();
    });
  });
});
