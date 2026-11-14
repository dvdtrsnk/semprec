import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getOrCreateTickThread,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createItemWithClient,
  createPendingApprovalRequest,
  createSempChatThread,
  createUser,
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  updateHeartbeatName,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

const PASSWORD = "thread-list-password";

const rowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["chat", "item", "tick"]),
  title: z.string().nullable(),
  preview: z.union([z.string(), z.strictObject({ key: z.string(), params: z.unknown() })]).nullable(),
  lastActivityAt: z.iso.datetime(),
  hasPendingApproval: z.boolean(),
  pendingApproval: z
    .strictObject({
      description: z.strictObject({ key: z.string(), params: z.record(z.string(), z.unknown()) }).nullable(),
      sourceKind: z.enum(["genericOperation", "mcpInvoke", "moduleTool"]),
    })
    .nullable(),
  heartbeat: z
    .strictObject({ id: z.uuid(), name: z.string(), projectItemId: z.uuid(), projectName: z.string().nullable() })
    .nullable(),
  subject: z.strictObject({ inboxItemId: z.uuid(), proposalId: z.uuid().nullable(), exists: z.boolean() }).nullable(),
});
const listSchema = z.strictObject({ rows: z.array(rowSchema), nextCursor: z.string().nullable() });
type ListRow = z.infer<typeof rowSchema>;

interface Session {
  tenant: string;
  userId: string;
  headers: Record<string, string>;
}

/** A tenant with its user and that user's bearer session; `seed` adds the system databases. */
async function tenantSession(options: { locale?: string; seed?: boolean } = {}): Promise<Session> {
  const tenant = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, {
    tenantId: tenant,
    email,
    passwordHash: await hashPassword(PASSWORD),
    locale: options.locale,
  });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  if (options.seed !== false) await runInTenant(tenant, () => seedSystem(pool));
  return {
    tenant,
    userId: user.id,
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
  };
}

function get(session: Session, query = ""): Promise<Response> {
  return fetch(`${baseUrl}/api/semp/threads${query}`, { headers: session.headers });
}

async function list(session: Session, query = ""): Promise<z.infer<typeof listSchema>> {
  const response = await get(session, query);
  expect(response.status, `GET /api/semp/threads${query}`).toBe(200);
  return listSchema.parse(await response.json());
}

function byId(rows: readonly ListRow[], id: string): ListRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Thread ${id} is not in the list`);
  return row;
}

/** Sends the first message of a new thread through the production route and returns the thread id. */
async function startThread(session: Session, text: string, inboxItemId?: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/semp/threads`, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify(inboxItemId === undefined ? { text } : { text, subject: { inboxItemId } }),
  });
  expect(response.status).toBe(202);
  return z.object({ threadId: z.uuid() }).parse(await response.json()).threadId;
}

async function inboxDatabaseId(session: Session): Promise<string> {
  const inbox = await runInTenant(session.tenant, () =>
    withTransaction(pool, (client) => getDatabaseByModuleId(client, "inbox")),
  );
  if (!inbox) throw new Error("Missing seeded Inbox database");
  return inbox.id;
}

async function createInboxItem(session: Session, properties: Record<string, unknown>): Promise<string> {
  const databaseId = await inboxDatabaseId(session);
  const item = await runInTenant(session.tenant, () =>
    withTransaction(pool, (client) =>
      createItemWithClient(client, { databaseId, properties: { date: "2026-01-01", time: "12:00", ...properties } }),
    ),
  );
  return item.id;
}

async function createProject(session: Session, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(session.tenant, async () => {
    const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!projects) throw new Error("Missing seeded Projects database");
    return (await createChokePoint(pool).createItem({ databaseId: projects.id, properties })).id;
  });
}

/** A heartbeat of `projectItemId` and its tick thread, both through their production writers. */
async function createTickThread(
  session: Session,
  projectItemId: string,
  name: string,
): Promise<{ heartbeatId: string; threadId: string }> {
  return runInTenant(session.tenant, () =>
    withTransaction(pool, async (client) => {
      const heartbeat = await createHeartbeat(client, {
        projectItemId,
        name,
        rule: { kind: "weekly", days: ["sun"], at: "21:00" },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "Plan the week" },
      });
      return { heartbeatId: heartbeat.id, threadId: (await getOrCreateTickThread(client, heartbeat.id)).id };
    }),
  );
}

/** The stored title of a thread and its row version: `xmin` changes with every write to the row. */
async function storedThread(session: Session, threadId: string): Promise<{ title: string | null; version: string }> {
  const { rows } = await runInTenant(session.tenant, () =>
    pool.query<{ title: string | null; version: string }>(
      "SELECT title, xmin::text AS version FROM semp_threads WHERE id = $1",
      [threadId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("Missing thread row");
  return row;
}

async function decide(session: Session, approvalRequestId: string, decision: "approved" | "rejected"): Promise<void> {
  const response = await fetch(`${baseUrl}/api/approval-requests/${approvalRequestId}`, {
    method: "PATCH",
    headers: session.headers,
    body: JSON.stringify({ decision }),
  });
  expect(response.status).toBe(200);
}

/** Every page of the list for `filter`, read with `limit` by following `nextCursor` until it is null. */
async function drain(session: Session, limit: number, filter = ""): Promise<ListRow[][]> {
  const pages: ListRow[][] = [];
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof listSchema> = await list(
      session,
      `?limit=${limit}${filter}${cursor === null ? "" : `&cursor=${cursor}`}`,
    );
    pages.push(page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return pages;
}

/** Raw SQL: only the title job writes a chat title, and it needs a model call through the AI gateway. */
async function setChatTitle(session: Session, threadId: string, title: string): Promise<void> {
  const updated = await runInTenant(session.tenant, () =>
    pool.query("UPDATE semp_threads SET title = $2 WHERE id = $1", [threadId, title]),
  );
  expect(updated.rowCount).toBe(1);
}

/** Sends a further message to a thread through the production route. */
async function sendMessage(session: Session, threadId: string, text: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(202);
}

/** The ids of the threads the list returns for `q`, in list order. */
async function search(session: Session, q: string, filter = ""): Promise<string[]> {
  return (await list(session, `?q=${encodeURIComponent(q)}${filter}`)).rows.map((row) => row.id);
}

function encodeCursor(text: string): string {
  return Buffer.from(text).toString("base64url");
}

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  pool = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runAsSystem("test:role", () =>
    pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: { async sendPasswordResetEmail() {} },
    appBaseUrl: "https://example.test",
    setupToken: "test",
    moduleRegistry: await loadFullModuleRegistry(),
    blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-thread-list-test-${randomUUID()}`)),
    maxFileSizeBytes: 1024,
  });
  server = createServer(dispatch);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin?.end();
});

describe("GET /api/semp/threads (issue #1729)", () => {
  it("returns chats and item threads by default and tick threads only when asked for", async () => {
    const session = await tenantSession();
    const chatId = await startThread(session, "Plan the trip");
    const inboxItemId = await createInboxItem(session, { text: "Buy milk" });
    const itemId = await startThread(session, "Make it a task", inboxItemId);
    const projectItemId = await createProject(session, { name: "Weekly review" });
    const tick = await createTickThread(session, projectItemId, "Sunday planning");

    const byDefault = await list(session);
    expect(byDefault.rows.map((row) => row.id)).toEqual([itemId, chatId]);
    expect(byDefault.nextCursor).toBeNull();
    expect((await list(session, "?kind=chat,item")).rows).toEqual(byDefault.rows);

    expect(byId(byDefault.rows, chatId)).toMatchObject({ kind: "chat", title: null, heartbeat: null, subject: null });
    expect(byId(byDefault.rows, itemId)).toMatchObject({
      kind: "item",
      heartbeat: null,
      subject: { inboxItemId, proposalId: null, exists: true },
    });

    const ticks = await list(session, "?kind=tick");
    expect(ticks.rows.map((row) => row.id)).toEqual([tick.threadId]);
    expect(ticks.rows[0]).toMatchObject({
      kind: "tick",
      title: "Sunday planning",
      preview: null,
      heartbeat: { id: tick.heartbeatId, name: "Sunday planning", projectItemId, projectName: "Weekly review" },
      subject: null,
    });

    expect((await list(session, "?kind=chat")).rows.map((row) => row.id)).toEqual([chatId]);
    expect((await list(session, "?kind=item")).rows.map((row) => row.id)).toEqual([itemId]);
    expect((await list(session, "?kind=chat,chat")).rows.map((row) => row.id)).toEqual([chatId]);
    expect((await list(session, "?kind=tick,item,chat")).rows.map((row) => row.id)).toEqual([
      tick.threadId,
      itemId,
      chatId,
    ]);
  });

  it("shows the newest pending approval of a delegated run and clears it once every request is decided", async () => {
    const session = await tenantSession();
    const threadId = await startThread(session, "Tidy up my tasks");
    const quietId = await startThread(session, "No approvals here");
    const description = { key: "approval.itemDelete", params: { itemName: "Old bike", databaseKey: "tasks" } };
    const requests = await runInTenant(session.tenant, async () => {
      const parent = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "tidy",
        userId: session.userId,
        threadId,
      });
      const delegated = await createAgentRun(pool, {
        triggeredBy: "supervisor",
        task: "delete",
        parentRunId: parent.id,
      });
      expect(delegated.threadId).toBe(threadId);
      const generic = await createPendingApprovalRequest(pool, {
        agentRunId: delegated.id,
        toolName: "semprec.item.delete",
        riskClass: "destructive",
        payload: {
          operationName: "item.delete",
          canonicalInput: { itemId: randomUUID() },
          actor: { runId: delegated.id, agentProjectItemId: randomUUID(), userId: session.userId },
          resourceSnapshot: { kind: "item_delete", resourceId: randomUUID(), sha256: null },
        },
        resourceSnapshot: { kind: "item_delete", resourceId: randomUUID(), sha256: null },
        description,
      });
      return { delegatedRunId: delegated.id, genericId: generic.id };
    });

    const withGeneric = await list(session);
    expect(byId(withGeneric.rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description, sourceKind: "genericOperation" },
    });
    expect(byId(withGeneric.rows, quietId)).toMatchObject({ hasPendingApproval: false, pendingApproval: null });

    // A request of an outside MCP tool, created later and without a description, as before issue #1683.
    const mcpId = await runInTenant(session.tenant, async () => {
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: requests.delegatedRunId,
        toolName: "send_email",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { to: "x" } },
        resourceSnapshot: { kind: "mcp_invoke", resourceId: randomUUID(), sha256: null },
      });
      return request.id;
    });
    expect(byId((await list(session)).rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description: null, sourceKind: "mcpInvoke" },
    });

    // A request of a module agent tool (issue #1791), created last and so the newest.
    const moduleToolDescription = { key: "approval.moduleTool", params: { toolName: "gated.apply" } };
    const moduleToolId = await runInTenant(session.tenant, async () => {
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: requests.delegatedRunId,
        toolName: "gated.apply",
        riskClass: "write",
        payload: { moduleToolName: "gated.apply", args: { value: "x" } },
        resourceSnapshot: { kind: "module_tool", resourceId: "gated.apply", sha256: null },
        description: moduleToolDescription,
      });
      return request.id;
    });
    expect(byId((await list(session)).rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description: moduleToolDescription, sourceKind: "moduleTool" },
    });

    // A request of an agent's mail send (issue gh-1913), created last: a request of the module tool family too.
    const mailSendDescription = { key: "approval.emailSend", params: { mailboxName: "Personal", recipientCount: 2 } };
    const mailSendId = await runInTenant(session.tenant, async () => {
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: requests.delegatedRunId,
        toolName: "mail.draft.send",
        riskClass: "outbound",
        payload: {
          draftId: randomUUID(),
          draftHash: "0".repeat(64),
          mailboxId: randomUUID(),
          to: [{ address: "x@example.test" }],
          subject: "Subject",
          body: "Body",
        },
        resourceSnapshot: { kind: "mail_draft", resourceId: randomUUID(), sha256: "0".repeat(64) },
        description: mailSendDescription,
      });
      return request.id;
    });
    expect(byId((await list(session)).rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description: mailSendDescription, sourceKind: "moduleTool" },
    });

    await decide(session, mailSendId, "rejected");
    expect(byId((await list(session)).rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description: moduleToolDescription, sourceKind: "moduleTool" },
    });

    await decide(session, moduleToolId, "rejected");
    expect(byId((await list(session)).rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description: null, sourceKind: "mcpInvoke" },
    });

    await decide(session, mcpId, "rejected");
    expect(byId((await list(session)).rows, threadId)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { description, sourceKind: "genericOperation" },
    });

    await decide(session, requests.genericId, "rejected");
    const decided = byId((await list(session)).rows, threadId);
    expect(decided).toMatchObject({ hasPendingApproval: false, pendingApproval: null });
    // The rejection wrote its outcome into the thread as a system message, which is now the last one.
    expect(decided.preview).toEqual({ key: "approval.outcome.rejected", params: description.params });
  });

  it("follows a renamed heartbeat and a changed Inbox item text without writing the thread", async () => {
    const session = await tenantSession();
    const projectItemId = await createProject(session, { name: "Household" });
    const tick = await createTickThread(session, projectItemId, "Morning check");
    const inboxItemId = await createInboxItem(session, { text: "Buy milk" });
    const itemId = await startThread(session, "Make it a task", inboxItemId);
    const before = { tick: await storedThread(session, tick.threadId), item: await storedThread(session, itemId) };
    expect(before.tick.title).toBeNull();
    expect(before.item.title).toBeNull();

    expect(byId((await list(session, "?kind=tick")).rows, tick.threadId).title).toBe("Morning check");
    // The user's locale is the column default, cs.
    expect(byId((await list(session)).rows, itemId).title).toBe("Úprava: Buy milk");

    await runInTenant(session.tenant, async () => {
      expect((await updateHeartbeatName(pool, tick.heartbeatId, "Evening check"))?.name).toBe("Evening check");
      await createChokePoint(pool).updateItem({
        databaseId: await inboxDatabaseId(session),
        itemId: inboxItemId,
        propertiesPatch: { text: "Buy bread for $& and $1" },
      });
    });

    const renamed = byId((await list(session, "?kind=tick")).rows, tick.threadId);
    expect(renamed.title).toBe("Evening check");
    expect(renamed.heartbeat?.name).toBe("Evening check");
    expect(byId((await list(session)).rows, itemId).title).toBe("Úprava: Buy bread for $& and $1");
    expect(await storedThread(session, tick.threadId)).toEqual(before.tick);
    expect(await storedThread(session, itemId)).toEqual(before.item);
  });

  it("fills the item title template of the caller's locale and gives no title without item text", async () => {
    const session = await tenantSession({ locale: "en" });
    const withText = await createInboxItem(session, { text: "Call the plumber" });
    const withoutText = await createInboxItem(session, {});
    const blank = await createInboxItem(session, { text: "   " });
    const titledId = await startThread(session, "Edit it", withText);
    const untitledId = await startThread(session, "Edit it", withoutText);
    const blankId = await startThread(session, "Edit it", blank);

    const live = await list(session, "?kind=item");
    expect(byId(live.rows, titledId)).toMatchObject({ title: "Edit: Call the plumber", subject: { exists: true } });
    expect(byId(live.rows, untitledId)).toMatchObject({ title: null, subject: { exists: true } });
    expect(byId(live.rows, blankId)).toMatchObject({ title: null, subject: { exists: true } });

    await runInTenant(session.tenant, async () =>
      createChokePoint(pool).softDeleteItem(await inboxDatabaseId(session), withText),
    );
    expect(byId((await list(session, "?kind=item")).rows, titledId)).toMatchObject({
      title: null,
      subject: { inboxItemId: withText, proposalId: null, exists: false },
    });
  });

  it("returns the stored title of a chat thread", async () => {
    const session = await tenantSession({ seed: false });
    const titledId = await startThread(session, "Where should we go in May?");
    const untitledId = await startThread(session, "Another question");
    await setChatTitle(session, titledId, "Trip in May");

    const { rows } = await list(session);
    expect(byId(rows, titledId).title).toBe("Trip in May");
    expect(byId(rows, untitledId).title).toBeNull();
  });

  it("names the project of a tick thread only while the project item is live and has a name", async () => {
    const session = await tenantSession();
    const named = await createProject(session, { name: "Garden" });
    const unnamed = await createProject(session, {});
    const namedTick = await createTickThread(session, named, "Water the plants");
    const unnamedTick = await createTickThread(session, unnamed, "Sweep the yard");

    const live = await list(session, "?kind=tick");
    expect(byId(live.rows, namedTick.threadId).heartbeat).toMatchObject({
      projectItemId: named,
      projectName: "Garden",
    });
    expect(byId(live.rows, unnamedTick.threadId).heartbeat).toMatchObject({
      projectItemId: unnamed,
      projectName: null,
    });

    await runInTenant(session.tenant, async () => {
      const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!projects) throw new Error("Missing seeded Projects database");
      await createChokePoint(pool).softDeleteItem(projects.id, named);
    });
    expect(byId((await list(session, "?kind=tick")).rows, namedTick.threadId).heartbeat).toMatchObject({
      name: "Water the plants",
      projectItemId: named,
      projectName: null,
    });
  });

  it("cuts a text preview to 140 code points with an ellipsis and removes Markdown", async () => {
    const session = await tenantSession({ seed: false });
    // Astral characters count as one code point each, although each takes two UTF-16 units.
    const exact = `${"😀".repeat(2)}${"a".repeat(138)}`;
    const exactId = await startThread(session, exact);
    const longer = `${"😀".repeat(139)}xyz tail`;
    const longerId = await startThread(session, longer);
    const markdownId = await startThread(
      session,
      "# Shopping **list**\n- [ ] buy *milk*\n- see [the note](https://example.test/note) and `code`",
    );
    // The link ends inside the 1000 code points the list reads, so what is visible of them is short; the text goes on.
    const hiddenLink = `[doc](https://example.test/${"a".repeat(900)})`;
    const cutId = await startThread(session, `${hiddenLink} ${"word ".repeat(100)}`);

    const { rows } = await list(session);
    expect(byId(rows, exactId).preview).toBe(exact);
    expect(byId(rows, longerId).preview).toBe(`${"😀".repeat(139)}x…`);
    expect(byId(rows, markdownId).preview).toBe("Shopping list buy milk see the note and code");
    expect(byId(rows, cutId).preview).toBe(`doc ${"word ".repeat(14)}w…`);
  });

  it("pages through the list with the returned cursor without skipping or repeating a row", async () => {
    const session = await tenantSession({ seed: false });
    const first = await startThread(session, "one");
    const second = await startThread(session, "two");
    const third = await startThread(session, "three");
    const fourth = await startThread(session, "four");
    const fifth = await startThread(session, "five");
    // Raw SQL: no production write gives two threads the same activity instant, or instants one microsecond apart.
    const instants = new Map([
      [first, "2026-03-01T10:00:00.000002Z"],
      [second, "2026-03-01T10:00:00.000001Z"],
      [third, "2026-03-01T09:00:00.500000Z"],
      [fourth, "2026-03-01T09:00:00.500000Z"],
      [fifth, "2026-02-28T23:59:59.999999Z"],
    ]);
    await runInTenant(session.tenant, async () => {
      for (const [id, instant] of instants) {
        const updated = await pool.query("UPDATE semp_threads SET last_activity_at = $2::timestamptz WHERE id = $1", [
          id,
          instant,
        ]);
        expect(updated.rowCount).toBe(1);
      }
    });
    // Equal instants are ordered by id descending; Postgres compares uuids as their hex text compares.
    const tied = [third, fourth].sort().reverse();
    const expected = [first, second, ...tied, fifth];

    // Limit 1 puts a page boundary between the two instants one microsecond apart, limits 1 and 3 between the tied rows.
    for (const [limit, pageSizes] of [
      [1, [1, 1, 1, 1, 1]],
      [2, [2, 2, 1]],
      [3, [3, 2]],
    ] as const) {
      const pages = await drain(session, limit);
      expect(
        pages.map((page) => page.length),
        `limit ${limit}`,
      ).toEqual(pageSizes);
      const rows = pages.flat();
      expect(
        rows.map((row) => row.id),
        `limit ${limit}`,
      ).toEqual(expected);
      const times = rows.map((row) => Date.parse(row.lastActivityAt));
      expect(times).toEqual([...times].sort((left, right) => right - left));
    }

    // A page that ends exactly at the last row has no cursor; one row short of it has one.
    expect((await list(session, "?limit=5")).nextCursor).toBeNull();
    const four = await list(session, "?limit=4");
    expect(four.rows.map((row) => row.id)).toEqual(expected.slice(0, 4));
    expect((await list(session, `?limit=4&cursor=${four.nextCursor}`)).rows.map((row) => row.id)).toEqual([fifth]);
    expect((await list(session, "?limit=100")).rows.map((row) => row.id)).toEqual(expected);
  });

  it("returns 50 rows when no limit is given", async () => {
    const session = await tenantSession({ seed: false });
    // One transaction, so the 51 threads share one activity instant and the page boundary falls between tied rows.
    await runInTenant(session.tenant, () =>
      withTransaction(pool, async (client) => {
        for (let index = 0; index < 51; index += 1) await createSempChatThread(client);
      }),
    );

    const firstPage = await list(session);
    expect(firstPage.rows).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await list(session, `?cursor=${firstPage.nextCursor}`);
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    const all = await list(session, "?limit=100");
    expect(all.rows).toHaveLength(51);
    expect([...firstPage.rows, ...secondPage.rows].map((row) => row.id)).toEqual(all.rows.map((row) => row.id));
    expect(new Set(all.rows.map((row) => row.id)).size).toBe(51);
    // A thread without a message has no preview.
    expect(all.rows.every((row) => row.preview === null && row.title === null)).toBe(true);
  });

  it("returns the thread of an Inbox item for subjectInboxItemId", async () => {
    const session = await tenantSession();
    const firstItem = await createInboxItem(session, { text: "First capture" });
    const secondItem = await createInboxItem(session, { text: "Second capture" });
    const firstThread = await startThread(session, "Edit the first", firstItem);
    await startThread(session, "Edit the second", secondItem);
    await startThread(session, "A chat");

    const found = await list(session, `?subjectInboxItemId=${firstItem}`);
    expect(found.rows.map((row) => row.id)).toEqual([firstThread]);
    expect(found.rows[0]?.subject).toEqual({ inboxItemId: firstItem, proposalId: null, exists: true });
    expect((await list(session, `?subjectInboxItemId=${randomUUID()}`)).rows).toEqual([]);
    // The filters combine: the item thread is not a chat.
    expect((await list(session, `?kind=chat&subjectInboxItemId=${firstItem}`)).rows).toEqual([]);
  });

  it("refuses an invalid query parameter as a validation error that names it", async () => {
    const session = await tenantSession({ seed: false });
    const id = "6f1f2c0e-3a51-4c0f-9a53-0b1c2d3e4f50";
    const cases: Array<[query: string, field: string]> = [
      ["?kind=audio", "kind"],
      ["?kind=chat,,tick", "kind"],
      ["?kind=", "kind"],
      ["?kind=Chat", "kind"],
      ["?kind=chat&kind=tick", "kind"],
      ["?subjectInboxItemId=not-a-uuid", "subjectInboxItemId"],
      ["?subjectInboxItemId=", "subjectInboxItemId"],
      ["?limit=0", "limit"],
      ["?limit=101", "limit"],
      ["?limit=1.5", "limit"],
      ["?limit=abc", "limit"],
      ["?limit=", "limit"],
      ["?limit=5&limit=6", "limit"],
      ["?cursor=", "cursor"],
      ["?cursor=***", "cursor"],
      [`?cursor=${"a".repeat(129)}`, "cursor"],
      [`?cursor=${encodeCursor("not a cursor")}`, "cursor"],
      [`?cursor=${encodeCursor(`2026-03-01T10:00:00.000Z|${id}`)}`, "cursor"],
      [`?cursor=${encodeCursor(`2026-02-30T10:00:00.000000Z|${id}`)}`, "cursor"],
      [`?cursor=${encodeCursor(`2026-03-01T25:00:00.000000Z|${id}`)}`, "cursor"],
      [`?cursor=${encodeCursor(`0000-03-01T10:00:00.000000Z|${id}`)}`, "cursor"],
      [`?cursor=${encodeCursor("2026-03-01T10:00:00.000000Z|not-a-uuid")}`, "cursor"],
      [`?cursor=${encodeCursor(`2026-03-01T10:00:00.000000Z|${id}`)}&cursor=x`, "cursor"],
    ];
    for (const [query, field] of cases) {
      const response = await get(session, query);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({ error: { code: "validation_failed", details: { field } } });
    }
    // A well-formed cursor of a position that holds no row is an empty page, not an error.
    const valid = await list(session, `?cursor=${encodeCursor(`2026-03-01T10:00:00.000000Z|${id}`)}`);
    expect(valid).toEqual({ rows: [], nextCursor: null });
  });

  it("requires a session", async () => {
    const response = await fetch(`${baseUrl}/api/semp/threads`);
    expect(response.status).toBe(401);
  });

  it("never shows a thread, title, preview or approval of another tenant", async () => {
    const owner = await tenantSession();
    const other = await tenantSession();
    const ownerChat = await startThread(owner, "Owner's private question");
    const ownerInboxItem = await createInboxItem(owner, { text: "Owner's capture" });
    const ownerItem = await startThread(owner, "Edit the owner's capture", ownerInboxItem);
    const ownerTick = await createTickThread(
      owner,
      await createProject(owner, { name: "Owner project" }),
      "Owner tick",
    );
    await runInTenant(owner.tenant, async () => {
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "owner",
        userId: owner.userId,
        threadId: ownerChat,
      });
      await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "mcp_invoke", resourceId: randomUUID(), sha256: null },
      });
    });
    const otherChat = await startThread(other, "Other's question");
    const otherTick = await createTickThread(
      other,
      await createProject(other, { name: "Other project" }),
      "Other tick",
    );

    const ownerRows = (await list(owner, "?kind=chat,item,tick")).rows;
    expect(ownerRows.map((row) => row.id).sort()).toEqual([ownerChat, ownerItem, ownerTick.threadId].sort());
    expect(byId(ownerRows, ownerChat).hasPendingApproval).toBe(true);

    const ownerIds = [ownerChat, ownerItem, ownerTick.threadId, ownerInboxItem, ownerTick.heartbeatId];
    for (const query of ["", "?kind=chat,item,tick", "?kind=tick", `?subjectInboxItemId=${ownerInboxItem}`]) {
      const response = await get(other, query);
      expect(response.status, query).toBe(200);
      const text = await response.text();
      expect(
        [...ownerIds, "Owner"].filter((value) => text.includes(value)),
        query,
      ).toEqual([]);
    }
    const otherRows = (await list(other, "?kind=chat,item,tick")).rows;
    expect(otherRows.map((row) => row.id).sort()).toEqual([otherChat, otherTick.threadId].sort());
    expect(otherRows.every((row) => !row.hasPendingApproval)).toBe(true);
    // The owner's Inbox item answers the other tenant exactly as an id that does not exist.
    expect(await list(other, `?subjectInboxItemId=${ownerInboxItem}`)).toEqual(
      await list(other, `?subjectInboxItemId=${randomUUID()}`),
    );
    // A cursor taken from the owner's list positions the other tenant's list and reveals nothing.
    const ownerPage = await list(owner, "?kind=chat,item,tick&limit=1");
    expect(ownerPage.nextCursor).not.toBeNull();
    const continued = await list(other, `?kind=chat,item,tick&cursor=${ownerPage.nextCursor}`);
    expect(continued.rows.every((row) => [otherChat, otherTick.threadId].includes(row.id))).toBe(true);
  });
});

describe("GET /api/semp/threads with q (issue #1737)", () => {
  it("finds a thread by its title or by the start of its last message, whatever the case and diacritics", async () => {
    const session = await tenantSession({ seed: false });
    const titled = await startThread(session, "Kolik jsem platil?");
    await setChatTitle(session, titled, "Účtenka za oběd");
    const byMessage = await startThread(session, "Účtenka z lékárny je v tašce");
    await startThread(session, "Plán na víkend");

    for (const q of ["uctenka", "UCTENKA", "Účtenka", "úČTENka", "  uctenka  "]) {
      expect(await search(session, q), q).toEqual([byMessage, titled]);
    }
    expect(await search(session, "za obed")).toEqual([titled]);
    expect(await search(session, "LÉKÁRNY")).toEqual([byMessage]);
    expect(await list(session, "?q=kaleidoskop")).toEqual({ rows: [], nextCursor: null });
  });

  it("finds a tick thread by its heartbeat's current name and an item thread by its Inbox item's current text", async () => {
    const session = await tenantSession();
    const tick = await createTickThread(session, await createProject(session, { name: "Domácnost" }), "Ranní přehled");
    const inboxItemId = await createInboxItem(session, { text: "Zaplatit fakturu" });
    const itemThread = await startThread(session, "Zpracuj to", inboxItemId);

    expect(await search(session, "ranni", "&kind=tick")).toEqual([tick.threadId]);
    // Without `kind` the list holds chats and item threads only.
    expect(await search(session, "ranni")).toEqual([]);
    expect(await search(session, "fakturu")).toEqual([itemThread]);
    expect(await search(session, "fakturu", "&kind=tick")).toEqual([]);
    // The item title is "Úprava: Zaplatit fakturu"; the words of the template are not what is searched.
    expect(byId((await list(session)).rows, itemThread).title).toBe("Úprava: Zaplatit fakturu");
    expect(await search(session, "uprava")).toEqual([]);

    await runInTenant(session.tenant, async () => {
      expect((await updateHeartbeatName(pool, tick.heartbeatId, "Večerní souhrn"))?.name).toBe("Večerní souhrn");
      await createChokePoint(pool).updateItem({
        databaseId: await inboxDatabaseId(session),
        itemId: inboxItemId,
        propertiesPatch: { text: "Koupit lístky" },
      });
    });
    expect(await search(session, "vecerni", "&kind=tick")).toEqual([tick.threadId]);
    expect(await search(session, "ranni", "&kind=tick")).toEqual([]);
    expect(await search(session, "listky")).toEqual([itemThread]);
    expect(await search(session, "fakturu")).toEqual([]);

    // An Inbox item in the trash gives the thread no title, so its text no longer matches.
    await runInTenant(session.tenant, async () =>
      createChokePoint(pool).softDeleteItem(await inboxDatabaseId(session), inboxItemId),
    );
    expect(await search(session, "listky")).toEqual([]);
  });

  it("searches the first 140 code points of the last message for text that is not a word or a word start", async () => {
    const session = await tenantSession({ seed: false });
    // "zebra" ends at code point 140 here, and starts at code point 137 in the next thread.
    const inside = await startThread(session, `${"😀".repeat(135)}zebra and the rest`);
    await startThread(session, `${"😀".repeat(136)}zebra and the rest`);
    await startThread(session, `${"word ".repeat(40)}zebra`);
    // An earlier message of a thread is not its preview.
    const earlier = await startThread(session, "zebra at the start");
    await sendMessage(session, earlier, "a later message without it");

    // "ebra" is no word and no word start, so only the substring rule of the title and the preview applies.
    expect(await search(session, "ebra")).toEqual([inside]);
    expect(await search(session, "later message")).toEqual([earlier]);
  });

  it("finds a thread by a word beyond the preview window or in an earlier message (issue #1783)", async () => {
    const session = await tenantSession({ seed: false });
    const beyondWindow = await startThread(session, `${"word ".repeat(40)}zebra`);
    const earlier = await startThread(session, "zebra at the start");
    await sendMessage(session, earlier, "a later message without it");
    await startThread(session, "Nothing of the kind");

    expect(await search(session, "zebra")).toEqual([earlier, beyondWindow]);
  });

  it("finds a thread whose messages together hold every word of q, and none that holds only some (issue #1783)", async () => {
    const session = await tenantSession({ seed: false });
    const both = await startThread(session, "Přišla faktura od dodavatele");
    await sendMessage(session, both, "Smlouva čeká na podpis");
    const onlyOne = await startThread(session, "Přišla faktura");
    await sendMessage(session, onlyOne, "Nic dalšího");
    const apart = await startThread(session, "Smlouva čeká");

    expect(await search(session, "faktura smlouva")).toEqual([both]);
    expect(await search(session, "smlouva faktura")).toEqual([both]);
    expect(await search(session, "faktura")).toEqual([onlyOne, both]);
    expect(await search(session, "smlouva")).toEqual([apart, both]);
  });

  it("matches %, _ and a backslash in q only as themselves", async () => {
    const session = await tenantSession({ seed: false });
    const percent = await startThread(session, "Sleva 100% jen dnes");
    const percentDecoy = await startThread(session, "Sleva 100 korun");
    const underscore = await startThread(session, "Soubor snake_case.ts");
    await startThread(session, "Soubor snakeXcase.ts");
    const backslash = await startThread(session, "Cesta C:\\temp");
    await startThread(session, "Cesta C:/temp");

    // A q with no word has no word rule (issue #1783), so only the substring rule can match it.
    expect(await search(session, "%")).toEqual([percent]);
    expect(await search(session, "_")).toEqual([underscore]);
    expect(await search(session, "\\")).toEqual([backslash]);
    // A q with words also finds the threads that hold them (issue #1783): "100" is a word of both
    // Sleva threads. The text parser reads "C:/temp" as a path, so the word "temp" is not in the second
    // Cesta thread. The pattern of the substring rule treats % and the backslash as themselves, which
    // the symbol-only q above prove.
    expect(await search(session, "100%")).toEqual([percentDecoy, percent]);
    expect(await search(session, "snake_case")).toEqual([underscore]);
    expect(await search(session, "C:\\temp")).toEqual([backslash]);

    // unaccent folds these fullwidth and small forms to %, _ and a backslash. The folded character is
    // matched as itself too, never as a wildcard or as an escape of the character after it.
    for (const q of ["\uFF05", "\uFE6A"]) expect(await search(session, q), q).toEqual([percent]);
    expect(await search(session, "100\uFF05")).toEqual([percentDecoy, percent]);
    expect(await search(session, "\uFF3F")).toEqual([underscore]);
    expect(await search(session, "snake\uFF3Fcase")).toEqual([underscore]);
    for (const q of ["\uFF3C", "\uFE68", "\u2216"]) expect(await search(session, q), q).toEqual([backslash]);
    expect(await search(session, "C:\uFF3Ctemp")).toEqual([backslash]);
  });

  it("applies no filter for a q that is empty once its diacritics are removed", async () => {
    const session = await tenantSession({ seed: false });
    const cafe = await startThread(session, "Kavárna u nádraží");
    await startThread(session, "Knihovna u parku");
    // A thread without a title or a text preview: a filter that matches every text would drop it.
    await runInTenant(session.tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const withoutQ = await list(session);
    expect(withoutQ.rows).toHaveLength(3);

    // unaccent removes a combining mark, so nothing of these values is left to search for.
    for (const q of ["\u0301", "\u0301\u030C"]) {
      expect(await list(session, `?q=${encodeURIComponent(q)}`), q).toEqual(withoutQ);
    }
    // A combining mark next to a letter leaves the letter, and that is searched.
    expect(await search(session, "kava\u0301rna")).toEqual([cafe]);
  });

  it("combines q with kind, subjectInboxItemId and paging", async () => {
    const session = await tenantSession();
    const projectItemId = await createProject(session, { name: "Práce" });
    const alpha = await createTickThread(session, projectItemId, "Report alfa");
    const beta = await createTickThread(session, projectItemId, "Report beta");
    await createTickThread(session, projectItemId, "Úklid");
    const firstItem = await createInboxItem(session, { text: "Report z porady" });
    const secondItem = await createInboxItem(session, { text: "Report z cesty" });
    const firstItemThread = await startThread(session, "Zpracuj to", firstItem);
    const secondItemThread = await startThread(session, "Zpracuj to", secondItem);
    const chats: string[] = [];
    for (const text of ["report jedna", "nic", "report dva", "nic", "nic", "report tři", "report čtyři"]) {
      const id = await startThread(session, text);
      if (text.startsWith("report")) chats.push(id);
    }
    const matchingDefault = [...chats].reverse().concat(secondItemThread, firstItemThread);

    expect(await search(session, "report", "&kind=tick")).toEqual([beta.threadId, alpha.threadId]);
    expect(await search(session, "report", "&kind=chat")).toEqual([...chats].reverse());
    expect(await search(session, "report")).toEqual(matchingDefault);
    expect(await search(session, "report", "&kind=chat,item,tick")).toEqual([
      ...matchingDefault,
      beta.threadId,
      alpha.threadId,
    ]);

    expect(await search(session, "report", `&subjectInboxItemId=${firstItem}`)).toEqual([firstItemThread]);
    expect(await search(session, "cesty", `&subjectInboxItemId=${firstItem}`)).toEqual([]);

    // The filter is applied before the page is cut: every page is full until the matches run out.
    for (const [limit, pageSizes] of [
      [1, [1, 1, 1, 1, 1, 1]],
      [4, [4, 2]],
      [6, [6]],
    ] as const) {
      const pages = await drain(session, limit, "&q=report");
      expect(
        pages.map((page) => page.length),
        `limit ${limit}`,
      ).toEqual(pageSizes);
      expect(
        pages.flat().map((row) => row.id),
        `limit ${limit}`,
      ).toEqual(matchingDefault);
    }
    expect((await drain(session, 1, "&q=report&kind=tick")).flat().map((row) => row.id)).toEqual([
      beta.threadId,
      alpha.threadId,
    ]);
  });

  it("returns a matching row exactly as the unfiltered list returns it", async () => {
    const session = await tenantSession();
    const chat = await startThread(session, "Hledaná slova v chatu");
    await setChatTitle(session, chat, "Hledaný chat");
    await runInTenant(session.tenant, async () => {
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "search",
        userId: session.userId,
        threadId: chat,
      });
      await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "mcp_invoke", resourceId: randomUUID(), sha256: null },
        description: { key: "approval.mcpInvoke", params: { serverName: "Mail", toolName: "send_email" } },
      });
    });
    const item = await startThread(session, "Zpracuj to", await createInboxItem(session, { text: "Hledaný záznam" }));
    const tick = await createTickThread(session, await createProject(session, { name: "Hledání" }), "Hledaný úkol");

    const unfiltered = await list(session, "?kind=chat,item,tick");
    const filtered = await list(session, "?kind=chat,item,tick&q=hledan");
    expect(filtered.rows.map((row) => row.id)).toEqual([tick.threadId, item, chat]);
    expect(filtered.rows).toEqual(unfiltered.rows);
    expect(byId(filtered.rows, chat)).toMatchObject({
      hasPendingApproval: true,
      pendingApproval: { sourceKind: "mcpInvoke" },
    });
  });

  it("treats a blank q as no filter and refuses one longer than 100 code points or with a NUL character", async () => {
    const session = await tenantSession({ seed: false });
    await startThread(session, "První");
    await startThread(session, "Druhý");
    // A thread without a title or a text preview: a blank q read as a filter that matches every text would drop it.
    await runInTenant(session.tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const withoutQ = await list(session);
    expect(withoutQ.rows.map((row) => [row.title, row.preview])).toEqual([
      [null, null],
      [null, "Druhý"],
      [null, "První"],
    ]);
    for (const query of ["?q=", "?q=%20%20", "?q=%09%0A"]) {
      expect(await list(session, query), query).toEqual(withoutQ);
    }

    // The cap counts code points of the trimmed text: 100 astral characters pass, with or without blanks around them.
    const longest = "😀".repeat(100);
    expect(await list(session, `?q=${encodeURIComponent(longest)}`)).toEqual({ rows: [], nextCursor: null });
    expect(await list(session, `?q=${encodeURIComponent(`  ${longest}  `)}`)).toEqual({ rows: [], nextCursor: null });
    for (const query of [
      `?q=${encodeURIComponent(`${longest}😀`)}`,
      `?q=${"a".repeat(101)}`,
      "?q=prvni&q=druhy",
      "?q=prv%00ni",
    ]) {
      const response = await get(session, query);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({
        error: { code: "validation_failed", details: { field: "q" } },
      });
    }
  });

  it("does not match a system message", async () => {
    const session = await tenantSession({ seed: false });
    const threadId = await startThread(session, "Uklid moje úkoly");
    const requestId = await runInTenant(session.tenant, async () => {
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "tidy",
        userId: session.userId,
        threadId,
      });
      const request = await createPendingApprovalRequest(pool, {
        agentRunId: run.id,
        toolName: "send_email",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "mcp_invoke", resourceId: randomUUID(), sha256: null },
        description: { key: "approval.mcpInvoke", params: { serverName: "Zebra mail", toolName: "send_email" } },
      });
      return request.id;
    });
    expect(await search(session, "uklid")).toEqual([threadId]);

    // The rejection writes a system message, which becomes the preview: its key and parameters are not searched.
    await decide(session, requestId, "rejected");
    expect(byId((await list(session)).rows, threadId).preview).toEqual({
      key: "approval.outcome.rejected",
      params: { serverName: "Zebra mail", toolName: "send_email" },
    });
    for (const q of ["zebra", "rejected", "approval"]) expect(await search(session, q), q).toEqual([]);
    // The user message before it is still searched, as a message and no longer as the preview.
    expect(await search(session, "uklid")).toEqual([threadId]);
  });

  it("never matches a thread of another tenant", async () => {
    const owner = await tenantSession();
    const other = await tenantSession();
    const ownerChat = await startThread(owner, "Kaleidoskop v chatu");
    await setChatTitle(owner, ownerChat, "Kaleidoskop");
    const ownerItem = await startThread(
      owner,
      "Zpracuj to",
      await createInboxItem(owner, { text: "Kaleidoskop koupit" }),
    );
    const ownerTick = await createTickThread(
      owner,
      await createProject(owner, { name: "Hračky" }),
      "Kaleidoskop týdně",
    );
    const otherChat = await startThread(other, "Můj kaleidoskop");

    expect(await search(owner, "kaleidoskop", "&kind=chat,item,tick")).toEqual([
      ownerTick.threadId,
      ownerItem,
      ownerChat,
    ]);
    expect(await search(other, "kaleidoskop", "&kind=chat,item,tick")).toEqual([otherChat]);
    expect(await search(other, "koupit", "&kind=chat,item,tick")).toEqual([]);
    expect(await search(other, "tydne", "&kind=chat,item,tick")).toEqual([]);
  });
});
