import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import {
  AiGatewayFailedError,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
} from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import * as relationOps from "../../chokePoint/relationOps.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../../chokePoint/valueLinkWrites.js";
import { insertValueLink } from "../../chokePoint/valueLinksStore.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { reindexPersonEmails } from "../personEmailIndexStore.js";
import { createCoreTaskList } from "../../worker.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import { ingestEmailMessage } from "../ingest.js";
import {
  enqueueThreadProjectTriage,
  handleMailTriageThreadProject,
  MAIL_THREAD_PROJECT_FEATURE_KEY,
  MAIL_TRIAGE_THREAD_PROJECT_TASK,
  setThreadProjectTriageRuntime,
  THREAD_PROJECT_TRIAGE_DELAY_MS,
  triageThreadProject,
} from "../threadProjectTriage.js";

const USER = { writerKind: "user" } as const;

const noopStorage: BlobStorageWriter = {
  async writeStream() {
    throw new Error("writeStream is not used by this test");
  },
  async delete() {},
  readStream() {
    throw new Error("readStream is not used by this test");
  },
};

/** A tenant of the test with the ids its checks need. */
interface World {
  tenant: string;
  databases: Record<string, string>;
  properties: Record<
    "threadProject" | "threadCompany" | "emailFolder" | "emailAttachments" | "personCompanies" | "projectCompany",
    string
  >;
  mailboxId: string;
  inboxId: string;
  sentId: string;
}

interface TestThread {
  threadItemId: string;
  threadId: string;
  messageItemId: string;
}

interface IngestOptions {
  messageId?: string;
  from?: { name?: string; address: string };
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  folder?: "inbox" | "sent";
  inReplyTo?: string;
}

let admin: Pool;
let data: Pool;
let world: World;
const events: InvalidationEvent[] = [];

function inTenant<T>(fn: () => Promise<T>, tenant = world.tenant): Promise<T> {
  return runInTenant(tenant, fn);
}

function databaseId(key: string, target = world): string {
  const id = target.databases[key];
  if (!id) throw new Error(`the ${key} database is not seeded`);
  return id;
}

let cp: ChokePoint;

async function buildWorld(): Promise<World> {
  const tenant = await createTestTenant(admin);
  return runInTenant(tenant, async () => {
    await seedSystem(data);
    const listed = await cp.listDatabases();
    const databases = Object.fromEntries(
      listed.flatMap((database) => (database.ownerModuleId ? [[database.ownerModuleId, database.id]] : [])),
    );
    const idOf = (key: string): string => {
      const id = databases[key];
      if (!id) throw new Error(`the ${key} database is not seeded`);
      return id;
    };
    const propertyId = async (databaseKey: string, key: string): Promise<string> => {
      const property = (await cp.listProperties(idOf(databaseKey))).find((entry) => entry.key === key);
      if (!property) throw new Error(`the ${databaseKey}.${key} property is not seeded`);
      return property.id;
    };
    const properties = {
      threadProject: await propertyId("threads", "project"),
      threadCompany: await propertyId("threads", "company"),
      emailFolder: await propertyId("emails", "folder"),
      emailAttachments: await propertyId("emails", "attachments"),
      personCompanies: await propertyId("people", "companies"),
      projectCompany: await propertyId("projects", "company"),
    };
    const folder = (client: PoolClient, name: string, purpose: string) =>
      createItemWithClient(
        client,
        { databaseId: idOf("folders"), properties: { name, behavior: "folder", specialPurpose: purpose } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
    const ids = await withTransaction(data, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: idOf("mailboxes"),
        properties: { name: "Personal", provider: "generic" },
      });
      return {
        mailboxId: mailbox.id,
        inboxId: (await folder(client, "INBOX", "inbox")).id,
        sentId: (await folder(client, "Sent", "sent")).id,
      };
    });
    return { tenant, databases, properties, ...ids };
  });
}

/** One message through the sync writer, in the tenant's runtime-role transaction. */
async function ingest(options: IngestOptions = {}, target = world): Promise<TestThread> {
  const messageId = options.messageId ?? `<${randomUUID()}@example.test>`;
  return inTenant(
    () =>
      withTransaction(data, async (client) => {
        const result = await ingestEmailMessage(client, {
          emailsDatabaseId: databaseId("emails", target),
          filesDatabaseId: databaseId("files", target),
          folderRelationPropertyId: target.properties.emailFolder,
          attachmentsRelationPropertyId: target.properties.emailAttachments,
          mailboxItemId: target.mailboxId,
          folderItemId: options.folder === "sent" ? target.sentId : target.inboxId,
          messageId,
          ...(options.inReplyTo ? { inReplyTo: options.inReplyTo, references: [options.inReplyTo] } : {}),
          subject: options.subject ?? "Quote for the new website",
          envelope: {
            from: options.from ?? { name: "Klient", address: "klient@example.test" },
            to: [{ address: "me@example.test" }],
          },
          ...(options.bodyText !== undefined ? { bodyText: options.bodyText } : {}),
          ...(options.bodyText === undefined && options.bodyHtml === undefined
            ? { bodyText: "Please send a quote." }
            : {}),
          ...(options.bodyHtml !== undefined ? { bodyHtml: options.bodyHtml } : {}),
          attachments: [],
          storage: noopStorage,
          storageKeyPrefix: "thread-project-triage",
        });
        const { rows } = await client.query<Record<string, unknown>>(
          `SELECT t.id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id WHERE m.item_id = $1`,
          [result.itemId],
        );
        const row = z.object({ id: z.uuid(), item_id: z.uuid() }).parse(rows[0]);
        return { threadItemId: row.item_id, threadId: row.id, messageItemId: result.itemId };
      }),
    target.tenant,
  );
}

/** A Projects item; `status` is the select value. */
async function createProject(name: string, status: string, target = world): Promise<string> {
  const created = await inTenant(
    () =>
      cp.createItem({
        databaseId: databaseId("projects", target),
        properties: { name, status },
      }),
    target.tenant,
  );
  return created.id;
}

async function projectOf(threadItemId: string, target = world): Promise<string[]> {
  const edges = await inTenant(
    () => cp.listItemRelations(threadItemId, target.properties.threadProject),
    target.tenant,
  );
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

async function valueLinkRows(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM value_links");
  return rows[0]?.n ?? -1;
}

async function notificationCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications");
  return rows[0]?.n ?? -1;
}

/** A gateway that answers `answer(input)` and records every call. */
function gatewayAnswering(answer: (input: AiGatewayCompletionInput) => unknown) {
  const calls: AiGatewayCompletionInput[] = [];
  const client: AiGatewayClientPort = {
    async complete(input) {
      calls.push(input);
      return { content: await answer(input), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, client };
}

const choosing = (projectId: string | null, confidence = 0.95) => gatewayAnswering(() => ({ projectId, confidence }));

function failingGateway(reason: "timeout" | "http" | "budget_exceeded" | "invalid_response") {
  return gatewayAnswering(() => {
    throw new AiGatewayFailedError(reason);
  });
}

const triage = (threadItemId: string, gateway: AiGatewayClientPort, target = world) =>
  inTenant(() => triageThreadProject({ pool: data, gateway }, threadItemId), target.tenant);

/** The text of the one user message the gateway was given. */
function promptOf(call: AiGatewayCompletionInput | undefined): string {
  const message = call?.messages[0];
  if (typeof message?.content !== "string") throw new Error("Expected a text message");
  return message.content;
}

/** Runs the queued value-link propagation jobs until none is left. */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(data, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: data, taskList: { [taskName]: handler } });
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = $1",
      [taskName],
    );
    if (rows[0]?.n === 0) return;
  }
  throw new Error("Propagation queue did not drain");
}

const triageJobRow = z.object({
  key: z.string().nullable(),
  queue_name: z.string().nullable(),
  max_attempts: z.number(),
  run_at: z.date(),
  payload: z.object({ tenantId: z.uuid().nullable(), payload: z.object({ threadItemId: z.uuid() }).strict() }),
});

async function triageJobs() {
  // Graphile Worker 0.17.3's public jobs view omits the payload, so it is read from the private table, joined by id.
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT j.key, j.queue_name, j.max_attempts, j.run_at, p.payload
       FROM graphile_worker.jobs j JOIN graphile_worker._private_jobs p ON p.id = j.id
      WHERE j.task_identifier = $1 ORDER BY j.run_at, j.id`,
    [MAIL_TRIAGE_THREAD_PROJECT_TASK],
  );
  return rows.map((row) => triageJobRow.parse(row));
}

describe("the thread project triage task (issue gh-1872)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(data);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    world = await buildWorld();
    events.length = 0;
    setInvalidationHook((event) => events.push(event));
  });
  afterEach(() => {
    setInvalidationHook(() => {});
    setThreadProjectTriageRuntime(null);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await data?.end();
    await admin?.end();
  });

  describe("the queued task", () => {
    it("queues one delayed task, stamped with the tenant, for the first inbound message of a new thread", async () => {
      const before = Date.now();
      const thread = await ingest();
      const jobs = await triageJobs();
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      expect(job?.payload).toEqual({ tenantId: world.tenant, payload: { threadItemId: thread.threadItemId } });
      expect(job?.key).toBe(`${MAIL_TRIAGE_THREAD_PROJECT_TASK}:${thread.threadItemId}`);
      expect(job?.queue_name).toBe(`mail-thread-project:${world.tenant}`);
      expect(job?.max_attempts).toBe(3);
      // The wait lets the inheritance of gh-1869 run first.
      const delay = (job?.run_at.getTime() ?? 0) - before;
      expect(delay).toBeGreaterThanOrEqual(THREAD_PROJECT_TRIAGE_DELAY_MS - 1000);
      expect(delay).toBeLessThanOrEqual(THREAD_PROJECT_TRIAGE_DELAY_MS + 30_000);
    });

    it("queues nothing for a later message of a thread that has its first inbound message", async () => {
      const first = await ingest({ messageId: "<first@example.test>" });
      await ingest({ messageId: "<second@example.test>", inReplyTo: "<first@example.test>" });
      const jobs = await triageJobs();
      expect(jobs.map((job) => job.payload.payload.threadItemId)).toEqual([first.threadItemId]);
    });

    it("queues nothing for a thread that starts with a message of the user's own in Sent", async () => {
      await ingest({ folder: "sent" });
      expect(await triageJobs()).toEqual([]);
    });

    it("queues nothing when the ingesting transaction rolls back", async () => {
      await expect(
        inTenant(() =>
          withTransaction(data, async (client) => {
            await ingestEmailMessage(client, {
              emailsDatabaseId: databaseId("emails"),
              filesDatabaseId: databaseId("files"),
              folderRelationPropertyId: world.properties.emailFolder,
              attachmentsRelationPropertyId: world.properties.emailAttachments,
              mailboxItemId: world.mailboxId,
              folderItemId: world.inboxId,
              messageId: "<rolled-back@example.test>",
              subject: "Rolled back",
              envelope: { from: { address: "klient@example.test" }, to: [{ address: "me@example.test" }] },
              bodyText: "text",
              attachments: [],
              storage: noopStorage,
              storageKeyPrefix: "thread-project-triage",
            });
            throw new Error("roll back");
          }),
        ),
      ).rejects.toThrow("roll back");
      expect(await triageJobs()).toEqual([]);
    });

    it("collapses a repeated enqueue onto the waiting task and keeps its time", async () => {
      const thread = await ingest();
      const [first] = await triageJobs();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await inTenant(() => withTransaction(data, (client) => enqueueThreadProjectTriage(client, thread.threadItemId)));
      const jobs = await triageJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.run_at.getTime()).toBe(first?.run_at.getTime());
    });
  });

  describe("the assignment", () => {
    it("gives a thread with no project and no inherited link the chosen project as its own value, with no value link", async () => {
      const thread = await ingest();
      const web = await createProject("Website", "inProgress");
      await createProject("Other", "inProgress");
      const gateway = choosing(web);

      expect(await triage(thread.threadItemId, gateway.client)).toBe("assigned");

      expect(await projectOf(thread.threadItemId)).toEqual([web]);
      expect(await valueLinkRows()).toBe(0);
      const links = await inTenant(() => cp.getValueLinksForItems([thread.threadItemId]));
      expect(links.get(thread.threadItemId)?.project).toBeUndefined();
      expect(gateway.calls).toHaveLength(1);
    });

    it("writes as an agent writer with no run, asks for no approval and announces the thread after the commit", async () => {
      const thread = await ingest();
      const web = await createProject("Website", "inProgress");
      events.length = 0;
      const write = vi.spyOn(relationOps, "createRelationWithClient");

      await triage(thread.threadItemId, choosing(web).client);

      expect(write).toHaveBeenCalledTimes(1);
      const [, input, context, writer, acting] = write.mock.calls[0] ?? [];
      expect(input).toEqual({
        relationPropertyId: world.properties.threadProject,
        callerItemId: thread.threadItemId,
        targetItemId: web,
      });
      expect(context).toBeUndefined();
      expect(writer).toEqual({ writerKind: "agent" });
      expect(acting).toBeUndefined();
      const approvals = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_requests");
      expect(approvals.rows[0]?.n).toBe(0);
      expect(events).toContainEqual({ scope: "mailThread", threadId: thread.threadId });
    });

    it("accepts an answer at exactly the confidence threshold and one above it", async () => {
      const first = await ingest();
      const second = await ingest();
      const web = await createProject("Website", "inProgress");
      expect(await triage(first.threadItemId, choosing(web, 0.8).client)).toBe("assigned");
      expect(await triage(second.threadItemId, choosing(web, 1).client)).toBe("assigned");
      expect(await projectOf(first.threadItemId)).toEqual([web]);
      expect(await projectOf(second.threadItemId)).toEqual([web]);
    });

    it("asks the gateway under the feature key with no project, the cut message text, the sender and the subject", async () => {
      const thread = await ingest({
        subject: "Offer for November",
        from: { name: "Jana Nováková", address: "jana@firma.test" },
        bodyText: "x".repeat(4500),
      });
      await createProject("Website", "inProgress");
      const gateway = choosing(null);

      await triage(thread.threadItemId, gateway.client);

      const call = gateway.calls[0];
      expect(call).toMatchObject({ projectItemId: null, operation: MAIL_THREAD_PROJECT_FEATURE_KEY });
      expect(MAIL_THREAD_PROJECT_FEATURE_KEY).toBe("mailThreadProject");
      const prompt = promptOf(call);
      expect(prompt).toContain("Subject: Offer for November");
      expect(prompt).toContain("From: Jana Nováková <jana@firma.test>");
      expect(prompt.match(/x+/)?.[0]).toHaveLength(4000);
    });

    it("gives the model the text of an HTML message, not its markup", async () => {
      const thread = await ingest({ bodyHtml: "<p>Hello <b>world</b></p><script>alert(1)</script>" });
      await createProject("Website", "inProgress");
      const gateway = choosing(null);
      await triage(thread.threadItemId, gateway.client);
      const prompt = promptOf(gateway.calls[0]);
      expect(prompt).toContain("Hello world");
      expect(prompt).not.toContain("<p>");
    });

    it("spends the text budget on the visible words of a newsletter that opens with a long style block and indentation", async () => {
      const style = `<style>${"a{color:red}".repeat(3000)}</style>`;
      const cells = `<td>\n          word\n        </td>\n`.repeat(400);
      const bodyHtml =
        `<html><head>${style}</head><body>${"\n      ".repeat(3000)}` +
        `<table><tr>${cells}</tr></table><p>Invoice for the Website project</p></body></html>`;
      expect(bodyHtml.indexOf("Invoice")).toBeGreaterThan(40_000);
      const thread = await ingest({ bodyHtml });
      await createProject("Website", "inProgress");
      const gateway = choosing(null);

      await triage(thread.threadItemId, gateway.client);

      const prompt = promptOf(gateway.calls[0]);
      expect(prompt).toContain("Invoice for the Website project");
      expect(prompt).not.toMatch(/\n\s*\n\s*\n/);
      expect(prompt).not.toContain("{color:red}");
      expect(prompt).toContain("word word word");
    });

    it("cuts the text of an HTML message to 4000 characters after its whitespace is collapsed", async () => {
      const thread = await ingest({ bodyHtml: `<p>${"word  \n ".repeat(2000)}</p>` });
      await createProject("Website", "inProgress");
      const gateway = choosing(null);

      await triage(thread.threadItemId, gateway.client);

      const prompt = promptOf(gateway.calls[0]);
      const text = prompt.split("\n")[3] ?? "";
      expect(text).toHaveLength(4000);
      expect(text).toMatch(/^(word ){10}/);
    });

    it("offers at most 50 live projects of status inProgress or longTerm, most recently changed first", async () => {
      const thread = await ingest();
      const active: string[] = [];
      for (let index = 0; index < 52; index++)
        active.push(await createProject(`Active ${index}`, index % 2 === 0 ? "inProgress" : "longTerm"));
      // Changed after every active project, so that only the filter and not the limit leaves them out.
      const others = [
        await createProject("Done", "done"),
        await createProject("Archived", "archived"),
        await createProject("Trashed", "inProgress"),
      ];
      await inTenant(() => cp.softDeleteItem(databaseId("projects"), others[2] ?? ""));
      // Raw SQL: a chosen change time is not something the API can produce.
      await admin.query(
        `UPDATE items i SET updated_at = timestamptz '2026-01-01' + make_interval(mins => t.n::int)
         FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, n) WHERE i.id = t.id`,
        [[...active, ...others]],
      );
      const gateway = choosing(null);

      await triage(thread.threadItemId, gateway.client);

      const prompt = promptOf(gateway.calls[0]);
      const listed = z
        .array(z.object({ id: z.uuid(), name: z.string(), status: z.string() }))
        .parse(JSON.parse(prompt.slice(prompt.indexOf("Candidate projects: ") + "Candidate projects: ".length)));
      expect(listed.map((project) => project.id)).toEqual([...active].reverse().slice(0, 50));
      expect(new Set(listed.map((project) => project.status))).toEqual(new Set(["inProgress", "longTerm"]));
    });

    it.each([
      ["a null project", (_project: string, _done: string) => ({ projectId: null, confidence: 0.99 })],
      ["a confidence below the threshold", (project: string) => ({ projectId: project, confidence: 0.79 })],
      ["a project outside the candidates", (_project: string, done: string) => ({ projectId: done, confidence: 0.99 })],
      ["an id that names no project", () => ({ projectId: randomUUID(), confidence: 0.99 })],
      ["a confidence that is not a number", (project: string) => ({ projectId: project, confidence: "high" })],
      ["an answer that is not an object", () => "Website"],
    ])("leaves the project empty and records no error for %s", async (_name, answer) => {
      const thread = await ingest();
      const project = await createProject("Website", "inProgress");
      const done = await createProject("Finished", "done");
      const gateway = gatewayAnswering(() => answer(project, done));

      expect(await triage(thread.threadItemId, gateway.client)).toBe("noAssignment");

      expect(gateway.calls).toHaveLength(1);
      expect(await projectOf(thread.threadItemId)).toEqual([]);
      expect(await valueLinkRows()).toBe(0);
      expect(await notificationCount()).toBe(0);
    });

    it("leaves the project empty for an answer the gateway itself found invalid, without raising an error", async () => {
      const thread = await ingest();
      await createProject("Website", "inProgress");
      const gateway = failingGateway("invalid_response");
      expect(await triage(thread.threadItemId, gateway.client)).toBe("noAssignment");
      expect(await projectOf(thread.threadItemId)).toEqual([]);
      expect(await notificationCount()).toBe(0);
    });

    it("skips the thread silently when the tenant's AI budget is exhausted", async () => {
      const thread = await ingest();
      await createProject("Website", "inProgress");
      const gateway = failingGateway("budget_exceeded");

      expect(await triage(thread.threadItemId, gateway.client)).toBe("budgetExhausted");

      expect(await projectOf(thread.threadItemId)).toEqual([]);
      expect(await notificationCount()).toBe(0);
    });

    it.each(["timeout", "http"] as const)(
      "raises a gateway failure of reason %s, so that the queue runs the task again, and writes nothing",
      async (reason) => {
        const thread = await ingest();
        await createProject("Website", "inProgress");
        await expect(triage(thread.threadItemId, failingGateway(reason).client)).rejects.toMatchObject({ reason });
        expect(await projectOf(thread.threadItemId)).toEqual([]);
      },
    );

    it("holds no database connection while the gateway answers", async () => {
      const thread = await ingest();
      const web = await createProject("Website", "inProgress");
      let held = -1;
      const gateway = gatewayAnswering(() => {
        held = data.totalCount - data.idleCount;
        return { projectId: web, confidence: 0.9 };
      });
      await triage(thread.threadItemId, gateway.client);
      expect(held).toBe(0);
    });
  });

  describe("threads that are left alone", () => {
    async function expectUntouched(threadItemId: string, outcome: string, gateway: { calls: unknown[] }) {
      expect(outcome).toBe("notEligible");
      expect(gateway.calls).toEqual([]);
      expect(await projectOf(threadItemId)).toEqual([]);
    }

    it("skips a thread in the Trash", async () => {
      const thread = await ingest();
      await createProject("Website", "inProgress");
      await inTenant(() => cp.softDeleteItem(databaseId("threads"), thread.threadItemId));
      const gateway = choosing(null);
      await expectUntouched(thread.threadItemId, await triage(thread.threadItemId, gateway.client), gateway);
    });

    it("skips an id that names no Threads item and the Threads item of another tenant alike", async () => {
      const other = await buildWorld();
      const foreign = await ingest({}, other);
      await createProject("Website", "inProgress");
      const gateway = choosing(null);
      expect(await triage(randomUUID(), gateway.client)).toBe("notEligible");
      expect(await triage(foreign.threadItemId, gateway.client)).toBe("notEligible");
      expect(gateway.calls).toEqual([]);
    });

    it("skips a thread that already has a project of its own and leaves that project", async () => {
      const thread = await ingest();
      const own = await createProject("Own", "inProgress");
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: world.properties.threadProject, callerItemId: thread.threadItemId, targetItemId: own },
          USER,
        ),
      );
      const gateway = choosing(null);
      expect(await triage(thread.threadItemId, gateway.client)).toBe("notEligible");
      expect(gateway.calls).toEqual([]);
      expect(await projectOf(thread.threadItemId)).toEqual([own]);
    });

    it("skips a thread that inherited a project and leaves it inherited", async () => {
      const thread = await ingest({ from: { name: "John", address: "john@acme.test" } });
      const acme = (
        await inTenant(() =>
          cp.createItem({
            databaseId: databaseId("companies"),
            properties: { name: "Acme", web: "https://acme.test" },
          }),
        )
      ).id;
      const active = await createProject("Active", "inProgress");
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: world.properties.projectCompany, callerItemId: active, targetItemId: acme },
          USER,
        ),
      );
      const john = (
        await inTenant(() => cp.createItem({ databaseId: databaseId("people"), properties: { name: "John" } }))
      ).id;
      await inTenant(() => withTransaction(data, (client) => reindexPersonEmails(client, john, ["john@acme.test"])));
      await inTenant(() =>
        cp.createRelation(
          { relationPropertyId: world.properties.personCompanies, callerItemId: john, targetItemId: acme },
          USER,
        ),
      );
      await runPropagation();
      expect(await projectOf(thread.threadItemId)).toEqual([active]);
      expect(await valueLinkRows()).toBeGreaterThan(0);

      const gateway = choosing(null);
      expect(await triage(thread.threadItemId, gateway.client)).toBe("notEligible");
      expect(gateway.calls).toEqual([]);
      expect(await projectOf(thread.threadItemId)).toEqual([active]);
      const link = (await inTenant(() => cp.getValueLinksForItems([thread.threadItemId]))).get(thread.threadItemId);
      expect(link?.project).toMatchObject({ valueKind: "inherited" });
    });

    it("skips a thread whose project link was ended by the user, although it holds no project edge", async () => {
      const thread = await ingest({ from: { name: "John", address: "john@acme.test" } });
      const project = await createProject("Active", "inProgress");
      // A link row with no edge: the state after the user removed an inherited project (state `broken`).
      await inTenant(() =>
        withTransaction(data, (client) =>
          insertValueLink(client, {
            itemId: thread.threadItemId,
            propertyKey: "project",
            ruleKey: "threadProjectFromCompany",
            state: "broken",
            brokenBy: "user",
            brokenAt: new Date(),
            sources: [{ kind: "item", sourceItemId: project, sourcePropertyKey: "projects" }],
          }),
        ),
      );
      const gateway = choosing(project);
      await expectUntouched(thread.threadItemId, await triage(thread.threadItemId, gateway.client), gateway);
    });

    it("skips a Threads item that is bound to no mail thread", async () => {
      const thread = await ingest();
      await createProject("Website", "inProgress");
      await admin.query("UPDATE mail_threads SET item_id = NULL WHERE id = $1", [thread.threadId]);
      const gateway = choosing(null);
      await expectUntouched(thread.threadItemId, await triage(thread.threadItemId, gateway.client), gateway);
    });

    it("skips a thread that holds no inbound message", async () => {
      const thread = await ingest({ folder: "sent" });
      await createProject("Website", "inProgress");
      const gateway = choosing(null);
      await expectUntouched(thread.threadItemId, await triage(thread.threadItemId, gateway.client), gateway);
    });

    it("asks nothing when the tenant has no project to choose from", async () => {
      const thread = await ingest();
      await createProject("Finished", "done");
      const gateway = choosing(null);
      expect(await triage(thread.threadItemId, gateway.client)).toBe("noCandidates");
      expect(gateway.calls).toEqual([]);
      expect(await projectOf(thread.threadItemId)).toEqual([]);
    });
  });

  describe("a change between the answer and the write", () => {
    /** Runs `change` while the gateway "answers", then answers with `project`. */
    const changingWhileAsking = (project: string, change: () => Promise<void>) =>
      gatewayAnswering(async () => {
        await change();
        return { projectId: project, confidence: 0.95 };
      });

    it("discards the answer when the user set a project meanwhile, and keeps the user's project", async () => {
      const thread = await ingest();
      const suggested = await createProject("Suggested", "inProgress");
      const users = await createProject("Users", "inProgress");
      events.length = 0;
      const gateway = changingWhileAsking(suggested, async () => {
        await inTenant(() =>
          cp.createRelation(
            {
              relationPropertyId: world.properties.threadProject,
              callerItemId: thread.threadItemId,
              targetItemId: users,
            },
            USER,
          ),
        );
      });

      expect(await triage(thread.threadItemId, gateway.client)).toBe("stale");

      expect(await projectOf(thread.threadItemId)).toEqual([users]);
    });

    it("discards the answer when inheritance filled the project meanwhile, and keeps the inherited project", async () => {
      const thread = await ingest();
      const suggested = await createProject("Suggested", "inProgress");
      const inherited = await createProject("Inherited", "inProgress");
      const gateway = changingWhileAsking(suggested, async () => {
        await inTenant(() =>
          withTransaction(data, async (client) => {
            await insertValueLink(client, {
              itemId: thread.threadItemId,
              propertyKey: "project",
              ruleKey: "threadProjectFromCompany",
              sources: [{ kind: "item", sourceItemId: inherited, sourcePropertyKey: "projects" }],
            });
            await relationOps.createRelationWithClient(
              client,
              {
                relationPropertyId: world.properties.threadProject,
                callerItemId: thread.threadItemId,
                targetItemId: inherited,
              },
              { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
            );
          }),
        );
      });

      expect(await triage(thread.threadItemId, gateway.client)).toBe("stale");

      expect(await projectOf(thread.threadItemId)).toEqual([inherited]);
      const link = (await inTenant(() => cp.getValueLinksForItems([thread.threadItemId]))).get(thread.threadItemId);
      expect(link?.project).toMatchObject({ valueKind: "inherited" });
    });

    it("discards the answer when the thread went to the Trash meanwhile", async () => {
      const thread = await ingest();
      const suggested = await createProject("Suggested", "inProgress");
      const gateway = changingWhileAsking(suggested, async () => {
        await inTenant(() => cp.softDeleteItem(databaseId("threads"), thread.threadItemId));
      });

      expect(await triage(thread.threadItemId, gateway.client)).toBe("stale");

      expect(await projectOf(thread.threadItemId)).toEqual([]);
    });

    it("drops the answer, without an error, when the chosen project went to the Trash meanwhile", async () => {
      const thread = await ingest();
      const suggested = await createProject("Suggested", "inProgress");
      const gateway = changingWhileAsking(suggested, async () => {
        await inTenant(() => cp.softDeleteItem(databaseId("projects"), suggested));
      });
      events.length = 0;

      expect(await triage(thread.threadItemId, gateway.client)).toBe("stale");

      expect(await projectOf(thread.threadItemId)).toEqual([]);
      expect(events.filter((event) => event.scope === "mailThread")).toEqual([]);
    });
  });

  describe("tenant isolation", () => {
    it("offers and writes only the projects of the tenant the task runs in", async () => {
      const other = await buildWorld();
      const mine = await ingest();
      const theirs = await ingest({}, other);
      const myProject = await createProject("Mine", "inProgress");
      const theirProject = await createProject("Theirs", "inProgress", other);

      const refused = choosing(theirProject);
      expect(await triage(mine.threadItemId, refused.client)).toBe("noAssignment");
      expect(promptOf(refused.calls[0])).toContain(myProject);
      expect(promptOf(refused.calls[0])).not.toContain(theirProject);
      expect(await projectOf(mine.threadItemId)).toEqual([]);

      expect(await triage(theirs.threadItemId, choosing(theirProject).client, other)).toBe("assigned");
      expect(await projectOf(theirs.threadItemId, other)).toEqual([theirProject]);
      expect(await projectOf(mine.threadItemId)).toEqual([]);
    });
  });

  describe("the task handler", () => {
    it("throws, so that the queue retries, while no runtime is bound", async () => {
      const thread = await ingest();
      await expect(
        inTenant(() => handleMailTriageThreadProject({ threadItemId: thread.threadItemId })),
      ).rejects.toThrow("No thread project triage runtime is configured");
    });

    it("runs the triage with the bound runtime", async () => {
      const thread = await ingest();
      const web = await createProject("Website", "inProgress");
      setThreadProjectTriageRuntime({ pool: data, gateway: choosing(web).client });
      await inTenant(() => handleMailTriageThreadProject({ threadItemId: thread.threadItemId }));
      expect(await projectOf(thread.threadItemId)).toEqual([web]);
    });

    it.each([
      ["a thread id that is not a uuid", { threadItemId: "not-a-uuid" }],
      ["a missing thread id", {}],
      ["an extra key", { threadItemId: randomUUID(), tenantId: randomUUID() }],
    ])("refuses a payload with %s", async (_name, payload) => {
      setThreadProjectTriageRuntime({ pool: data, gateway: choosing(null).client });
      await expect(inTenant(() => handleMailTriageThreadProject(payload))).rejects.toThrow();
    });

    it("is declared by the mail manifest as a task of the api runtime and resolves to its handler", async () => {
      const registry = await loadFullModuleRegistry();
      const tasks = (await registry.getTasks()).filter((task) => task.name === MAIL_TRIAGE_THREAD_PROJECT_TASK);
      expect(tasks).toEqual([
        {
          moduleId: "mailSync",
          name: "mailTriageThreadProject",
          payloadSchemaExport: "mailTriageThreadProjectPayloadSchema",
          handlerExport: "handleMailTriageThreadProject",
          queueAffinity: "api",
        },
      ]);
      const [definition] = (await registry.getTaskDefinitions()).filter(
        (task) => task.name === MAIL_TRIAGE_THREAD_PROJECT_TASK,
      );
      expect(definition?.handler).toBe(handleMailTriageThreadProject);
    });
  });
});
