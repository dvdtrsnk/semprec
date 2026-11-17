import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  finishTickRunWithMessage,
  getOrCreateTickThread,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  buildAgentRunStepPage,
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createPendingApprovalRequest,
  createUser,
  createViewTypeRegistry,
  finishAgentRun,
  getDatabaseByModuleId,
  handleAgentRunEventsRetentionTask,
  hashPassword,
  insertAgentRunEvent,
  listAgentRunEventsAfter,
  listAgentRunEventsForStepPage,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  markApprovalRequestExecutionSucceeded,
  projectAgentRunStepPage,
  recordApprovalRequestOutcome,
  seedSystem,
  terminalizeApprovalRequestAsConflict,
  updateUserLocale,
  withTransaction,
  type AgentRunEventKind,
  type AgentRunRow,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import {
  createApproval,
  createChatRun,
  playQueuedAssistant,
  playReply,
  queueAssistantMessage,
  type ReplySetup,
} from "./agentRunReplyFixtures.js";

const PASSWORD = "agent-run-steps-password";
const DAY_MS = 24 * 60 * 60 * 1000;

const stepSchema = z.strictObject({
  stepId: z.string(),
  kind: z.enum(["start", "plan", "tool", "approval", "answer", "end", "error"]),
  state: z.enum(["running", "ok", "error", "waitingApproval"]),
  at: z.string(),
  durationMs: z.number().nullable(),
  toolCallId: z.string().nullable(),
  operation: z.string().nullable(),
  mcp: z
    .strictObject({
      toolRegistrationId: z.string(),
      serverItemId: z.string(),
      serverName: z.string(),
      toolName: z.string(),
    })
    .nullable(),
  approvalRequestId: z.string().nullable(),
  title: z.string(),
  targetName: z.string().nullable(),
  change: z.strictObject({ property: z.string(), from: z.unknown(), to: z.unknown() }).nullable(),
  summary: z.string().nullable(),
  approvalState: z.enum(["pending", "executing", "executed", "failed", "conflict", "rejected"]).optional(),
  conflictReason: z.string().optional(),
});

const pageSchema = z.strictObject({
  steps: z.array(stepSchema),
  nextCursor: z.string().nullable(),
  truncatedHistory: z.boolean(),
});

type Page = z.infer<typeof pageSchema>;

interface Session {
  tenant: string;
  userId: string;
  headers: { Authorization: string };
}

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

async function tenantSession(): Promise<Session> {
  const tenant = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword(PASSWORD) });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { tenant, userId: user.id, headers: { Authorization: `Bearer ${session.token}` } };
}

function createRun(session: Session, input: Partial<Parameters<typeof createAgentRun>[1]> = {}): Promise<AgentRunRow> {
  return runInTenant(session.tenant, () =>
    createAgentRun(pool, { userId: session.userId, triggeredBy: "user", task: "Summarize the inbox", ...input }),
  );
}

function addEvent(session: Session, runId: string, kind: AgentRunEventKind, payload: unknown) {
  return runInTenant(session.tenant, async () => {
    const stored = await insertAgentRunEvent(pool, runId, kind, payload);
    return { id: stored.id, at: stored.at };
  });
}

const addStatus = (session: Session, runId: string, status: "running" | "done" | "error") =>
  addEvent(session, runId, "run_status", { kind: "run_status", status });

const addMessage = (session: Session, runId: string, text: string, toolCalls = false) =>
  addEvent(session, runId, "message", {
    kind: "message",
    role: "assistant",
    text,
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text },
      ...(toolCalls ? [{ type: "toolCall", id: "call", name: "item_get", arguments: {} }] : []),
    ],
    stopReason: toolCalls ? "toolUse" : "stop",
  });

const addToolUse = (session: Session, runId: string, toolCallId: string, identity: Record<string, unknown> = {}) =>
  addEvent(session, runId, "tool_use", {
    kind: "tool_use",
    toolCallId,
    name: "item_get",
    arguments: { itemId: "secret-argument" },
    ...identity,
  });

const addToolResult = (session: Session, runId: string, toolCallId: string, extra: Record<string, unknown> = {}) =>
  addEvent(session, runId, "tool_result", {
    kind: "tool_result",
    toolCallId,
    name: "item_get",
    result: { content: [{ type: "text", text: "secret-result" }] },
    isError: false,
    ...extra,
  });

async function finish(session: Session, runId: string, status: "done" | "error" = "done"): Promise<void> {
  await runInTenant(session.tenant, () =>
    status === "done" ? finishAgentRun(pool, runId, "done", null) : finishAgentRun(pool, runId, "error", "internal"),
  );
  await addStatus(session, runId, status);
}

/** As a run that finished minutes ago has it. */
async function settle(session: Session, runId: string): Promise<void> {
  await runInTenant(session.tenant, () =>
    pool.query("UPDATE agent_runs SET finished_at = now() - interval '10 minutes' WHERE id = $1", [runId]),
  );
}

async function writeFinishedRun(session: Session, runId: string): Promise<void> {
  await addStatus(session, runId, "running");
  await addEvent(session, runId, "turn_start", { kind: "turn_start" });
  await addMessage(session, runId, "Let me look", true);
  await addToolUse(session, runId, "call-1", { operation: "item.get" });
  await addToolResult(session, runId, "call-1", { operation: "item.get" });
  await addToolUse(session, runId, "call-2", {
    mcp: { toolRegistrationId: randomUUID(), serverItemId: randomUUID(), serverName: "Weather", toolName: "forecast" },
  });
  await addToolResult(session, runId, "call-2");
  await addMessage(session, runId, "Here is what I found");
  await addEvent(session, runId, "turn_end", { kind: "turn_end" });
  await finish(session, runId);
}

async function getSteps(session: Session, runId: string, query = ""): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/api/agent-runs/${runId}/steps${query}`, { headers: session.headers });
  return { status: res.status, text: await res.text() };
}

async function readPage(session: Session, runId: string, query = ""): Promise<Page> {
  const answer = await getSteps(session, runId, query);
  expect(answer.status, answer.text).toBe(200);
  return pageSchema.parse(JSON.parse(answer.text));
}

function queryOf(after: string | null, limit: number): string {
  return `?limit=${limit}${after === null ? "" : `&after=${after}`}`;
}

/** Every page of `runId` read `limit` steps at a time, following the cursor; `prefix` scopes the query. */
async function readAllPages(session: Session, runId: string, limit: number, prefix = ""): Promise<Page[]> {
  const pages: Page[] = [];
  let after: string | null = null;
  do {
    const query = queryOf(after, limit);
    const page: Page = await readPage(session, runId, prefix === "" ? query : `${prefix}&${query.slice(1)}`);
    pages.push(page);
    after = page.nextCursor;
  } while (after !== null && pages.length < 10);
  return pages;
}

async function seededSession(locale: "cs" | "en" = "en"): Promise<Session> {
  const session = await tenantSession();
  await runInTenant(session.tenant, () => seedSystem(pool, createViewTypeRegistry()));
  // A new user reads Czech, so English is set explicitly.
  await updateUserLocale(admin, session.userId, locale);
  return session;
}

/** The queries the projection of `runId`'s first page makes; `check` sees the projected steps. */
function projectionQueries(
  session: Session,
  runId: string,
  check: (steps: Awaited<ReturnType<typeof projectAgentRunStepPage>>["steps"]) => void,
): Promise<number> {
  return runInTenant(session.tenant, () =>
    withTransaction(pool, async (client) => {
      const { events, hasMore } = await listAgentRunEventsForStepPage(client, runId, "0", 100);
      const page = buildAgentRunStepPage({ events, hasMore, after: "0", limit: 100, runSettled: false });
      let queries = 0;
      const counting: PoolClient = new Proxy(client, {
        get(target, property) {
          if (property === "query") queries += 1;
          return Reflect.get(target, property);
        },
      });
      check((await projectAgentRunStepPage(counting, page, { agentRunId: runId, locale: "en" })).steps);
      return queries;
    }),
  );
}

/** A tool call and its result with the same identity fields. */
async function addCall(session: Session, runId: string, toolCallId: string, identity: Record<string, unknown> = {}) {
  await addToolUse(session, runId, toolCallId, identity);
  await addToolResult(session, runId, toolCallId, identity);
}

describe("GET /api/agent-runs/:id/steps", () => {
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
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-agent-run-steps-${randomUUID()}`)),
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

  describe("steps and the cursor", () => {
    it("groups a finished run into titled start, plan, two tool steps, answer and end without arguments, results or thinking", async () => {
      const owner = await seededSession();
      const run = await createRun(owner);
      await writeFinishedRun(owner, run.id);

      const answer = await getSteps(owner, run.id);
      expect(answer.status).toBe(200);
      const result = pageSchema.parse(JSON.parse(answer.text));

      expect(result.steps.map((s) => [s.kind, s.state, s.title])).toEqual([
        ["start", "ok", "Run started"],
        ["plan", "ok", "Planning"],
        ["tool", "ok", "Reading an item"],
        ["tool", "ok", "Using forecast"],
        ["answer", "ok", "Answering"],
        ["end", "ok", "Run finished"],
      ]);
      expect(
        result.steps.filter((s) => s.kind === "tool").map((s) => [s.toolCallId, s.operation, s.mcp?.toolName]),
      ).toEqual([
        ["call-1", "item.get", undefined],
        ["call-2", null, "forecast"],
      ]);
      expect([result.nextCursor, result.truncatedHistory]).toEqual([null, false]);
      for (const hidden of [
        "private reasoning",
        "secret-argument",
        "secret-result",
        "Let me look",
        "Here is what I found",
      ]) {
        expect(answer.text).not.toContain(hidden);
      }
    });

    it("sets a tool step's duration from the times of its call and its result", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      const use = await addToolUse(owner, run.id, "call-1");
      const result = await addToolResult(owner, run.id, "call-1");
      // Database defaults a test cannot choose; pinned to see the subtraction.
      await runInTenant(owner.tenant, async () => {
        for (const [id, at] of [
          [use.id, "2026-11-01T10:00:00.000Z"],
          [result.id, "2026-11-01T10:00:02.500Z"],
        ]) {
          await pool.query("UPDATE agent_run_events SET at = $2 WHERE id = $1", [id, new Date(at ?? "")]);
        }
      });

      const { steps } = await readPage(owner, run.id);

      expect(steps.find((s) => s.kind === "tool")).toMatchObject({ at: "2026-11-01T10:00:00.000Z", durationMs: 2500 });
    });

    it("reads a finished run page by page with limit 2 as the unpaged read, in the order agent:watch replays its events", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await writeFinishedRun(owner, run.id);
      const events = await runInTenant(owner.tenant, () => listAgentRunEventsAfter(pool, run.id, "0"));
      const unpaged = await readPage(owner, run.id);

      const pages = await readAllPages(owner, run.id, 2);

      expect(pages.flatMap((p) => p.steps)).toEqual(unpaged.steps);
      expect(pages.map((p) => p.steps.length)).toEqual([2, 2, 2]);
      const stepIds = unpaged.steps.map((s) => s.stepId);
      expect(stepIds).toEqual(events.map((e) => e.id).filter((id) => stepIds.includes(id)));
      // A page ends after a whole step: cursors are never a tool_use.
      const toolUseIds = events.filter((e) => e.kind === "tool_use").map((e) => e.id);
      const cursors = pages.map((p) => p.nextCursor);
      expect(cursors.slice(0, -1).every((c) => c !== null && !toolUseIds.includes(c))).toBe(true);
      expect(cursors.at(-1)).toBeNull();
    });

    it("returns a call without a result as running, keeps the cursor before it and then returns it complete", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      const start = await addStatus(owner, run.id, "running");
      const use = await addToolUse(owner, run.id, "call-1", { operation: "item.get" });

      const running = await readPage(owner, run.id);

      expect(running.steps.map((s) => [s.stepId, s.kind, s.state, s.durationMs])).toEqual([
        [start.id, "start", "ok", null],
        [use.id, "tool", "running", null],
      ]);
      expect(running.nextCursor).toBe(start.id);

      const result = await addToolResult(owner, run.id, "call-1");
      const done = await readPage(owner, run.id, queryOf(running.nextCursor, 100));

      expect(done.steps.map((s) => [s.stepId, s.state])).toEqual([[use.id, "ok"]]);
      expect(done.steps[0]?.durationMs).toBe(Date.parse(result.at) - Date.parse(use.at));
      expect(done.nextCursor).toBe(result.id);
    });

    it("keeps the cursor at the request's own while the first step is still running", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      const use = await addToolUse(owner, run.id, "call-1");
      const before = String(BigInt(use.id) - 1n);

      expect((await readPage(owner, run.id)).nextCursor).toBe("0");
      expect((await readPage(owner, run.id, `?after=${before}`)).nextCursor).toBe(before);
    });

    it("never ends a page between parallel calls and their results", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      await addToolUse(owner, run.id, "a");
      await addToolUse(owner, run.id, "b");
      await addToolResult(owner, run.id, "b");
      await addToolResult(owner, run.id, "a");
      await finish(owner, run.id);

      const pages = await readAllPages(owner, run.id, 1);

      expect(pages.map((page) => page.steps.map((s) => [s.kind, s.toolCallId, s.state]))).toEqual([
        [["start", null, "ok"]],
        [
          ["tool", "a", "ok"],
          ["tool", "b", "ok"],
        ],
        [["end", null, "ok"]],
      ]);
    });

    it.each([
      ["isError is true", { isError: true }],
      ["the result's details say error", { result: { content: [], details: { error: true } } }],
      [
        "a row stored before the interrupted-result fix has error at the top level",
        { isError: undefined, result: "interrupted", error: true },
      ],
    ])("marks a tool step as an error when %s", async (_label, extra) => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addToolUse(owner, run.id, "call-1");
      await addToolResult(owner, run.id, "call-1", extra);
      await addCall(owner, run.id, "call-2");

      const { steps } = await readPage(owner, run.id);

      expect(steps.map((s) => [s.toolCallId, s.state])).toEqual([
        ["call-1", "error"],
        ["call-2", "ok"],
      ]);
    });

    it("ends the cursor of a settled run whose terminal step was never stored, and not while it is fresh", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      const use = await addToolUse(owner, run.id, "call-1");
      await runInTenant(owner.tenant, () => finishAgentRun(pool, run.id, "error", "internal"));

      const fresh = await readPage(owner, run.id);
      expect(fresh.steps.map((s) => s.state)).toEqual(["ok", "running"]);
      expect(fresh.nextCursor).not.toBeNull();

      await settle(owner, run.id);
      const pages = await readAllPages(owner, run.id, 1);

      expect(pages.flatMap((p) => p.steps).map((s) => [s.stepId, s.kind, s.state])).toEqual([
        [expect.any(String), "start", "ok"],
        [use.id, "tool", "error"],
      ]);
      expect(pages.at(-1)?.nextCursor).toBeNull();
    });

    it("maps a run that failed to an error step", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      await finish(owner, run.id, "error");

      const { steps, nextCursor } = await readPage(owner, run.id);

      expect(steps.map((s) => [s.kind, s.state])).toEqual([
        ["start", "ok"],
        ["error", "error"],
      ]);
      expect(nextCursor).toBeNull();
    });

    it("returns the events of one run only", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      const other = await createRun(owner);
      const own = await addStatus(owner, run.id, "running");
      await addStatus(owner, other.id, "running");

      expect((await readPage(owner, run.id)).steps.map((s) => s.stepId)).toEqual([own.id]);
    });
  });

  describe("title, target, change and summary", () => {
    const SECRET = "tok-1847-never-returned";

    function createTask(session: Session, name: string): Promise<{ databaseId: string; itemId: string }> {
      return runInTenant(session.tenant, async () => {
        const tasks = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
        if (!tasks) throw new Error("The Tasks database is missing");
        const task = await createChokePoint(pool).createItem({ databaseId: tasks.id, properties: { name } });
        return { databaseId: tasks.id, itemId: task.id };
      });
    }

    const patchIdentity = (task: { databaseId: string; itemId: string }) => ({
      operation: "item.patch",
      targetDatabaseId: task.databaseId,
      targetItemId: task.itemId,
    });

    /** The single step of a run with one call, and the raw answer. */
    async function onlyStep(session: Session, runId: string) {
      const answer = await getSteps(session, runId);
      expect(answer.status, answer.text).toBe(200);
      return {
        text: answer.text,
        step: pageSchema.parse(JSON.parse(answer.text)).steps.find((s) => s.kind !== "start"),
      };
    }

    it.each([
      ["en", "Buy milk", { title: "Changing a task", summary: "1 property changed" }],
      ["cs", "Koupit mléko", { title: "Změna úkolu", summary: "Změněna 1 vlastnost" }],
    ] as const)(
      "returns an item.patch on a task with its title, the task's name and the change, in %s",
      async (locale, name, texts) => {
        const owner = await seededSession(locale);
        const task = await createTask(owner, name);
        const run = await createRun(owner);
        // A finished item.patch call whose result reports changes, as the runtime stores it.
        await addStatus(owner, run.id, "running");
        await addToolUse(owner, run.id, "patch-1", { ...patchIdentity(task), name: "item_patch" });
        await addToolResult(owner, run.id, "patch-1", {
          ...patchIdentity(task),
          name: "item_patch",
          result: {
            content: [{ type: "text", text: `Patched ${SECRET}` }],
            details: { error: false, changes: [{ key: "status", before: "todo", after: "done" }] },
          },
        });

        const { step, text } = await onlyStep(owner, run.id);

        expect(step).toMatchObject({
          operation: "item.patch",
          targetName: name,
          change: { property: "status", from: "todo", to: "done" },
          approvalRequestId: null,
          ...texts,
        });
        expect(text).not.toContain(SECRET);
      },
    );

    it.each([
      ["en", ["Searching tasks", "Creating a task"]],
      ["cs", ["Vyhledávání úkolů", "Vytvoření úkolu"]],
    ] as const)("titles database.query and item.create over the task database in %s", async (locale, titles) => {
      const owner = await seededSession(locale);
      const task = await createTask(owner, "Any");
      const run = await createRun(owner);
      for (const [callId, operation] of [
        ["q", "database.query"],
        ["n", "item.create"],
      ] as const) {
        await addCall(owner, run.id, callId, { operation, targetDatabaseId: task.databaseId });
      }

      const steps = (await readPage(owner, run.id)).steps;

      expect(steps.map((s) => [s.title, s.targetName])).toEqual([
        [titles[0], null],
        [titles[1], null],
      ]);
    });

    it("names an MCP tool in the title and shows neither its arguments nor its output", async () => {
      const owner = await seededSession();
      const run = await createRun(owner);
      const mcp = {
        toolRegistrationId: randomUUID(),
        serverItemId: randomUUID(),
        serverName: "Weather",
        toolName: "forecast",
      };
      await addToolUse(owner, run.id, "m1", { mcp, arguments: { city: SECRET } });
      await addToolResult(owner, run.id, "m1", {
        mcp,
        result: { content: [{ type: "text", text: `sunny ${SECRET}` }], details: { error: false } },
      });

      const { step, text } = await onlyStep(owner, run.id);

      expect(step).toMatchObject({ title: "Using forecast", mcp: { serverName: "Weather" }, targetName: null });
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("sunny");
    });

    it("marks a call that created an approval request as an approval step with its request id and no argument", async () => {
      const owner = await seededSession();
      const task = await createTask(owner, "Old task");
      const run = await createRun(owner);
      const requestId = randomUUID();
      const identity = { operation: "item.delete", targetDatabaseId: task.databaseId, targetItemId: task.itemId };
      await addToolUse(owner, run.id, "d1", { ...identity, arguments: { itemId: task.itemId, reason: SECRET } });
      await addToolResult(owner, run.id, "d1", {
        ...identity,
        result: {
          content: [{ type: "text", text: `Approval request ${requestId} ${SECRET}` }],
          details: { error: false, approvalRequestId: requestId },
        },
      });

      const { step, text } = await onlyStep(owner, run.id);

      expect(step).toMatchObject({
        kind: "approval",
        state: "ok",
        approvalRequestId: requestId,
        title: "Deleting a task",
        targetName: "Old task",
        summary: "Approval requested",
      });
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("reason");
    });

    it.each([
      ["a failed patch", `validation_failed: ${SECRET}`, ["validation_failed", SECRET]],
      // The shape the startup repair writes for a call without a result.
      ["a call interrupted by a restart", "interrupted_by_restart", ["interrupted_by_restart"]],
    ])("returns %s as an error step without its raw error text", async (_name, errorText, hidden) => {
      const owner = await seededSession();
      const task = await createTask(owner, "Task");
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      await addToolUse(owner, run.id, "f1", patchIdentity(task));
      await addToolResult(owner, run.id, "f1", {
        ...patchIdentity(task),
        isError: true,
        result: { content: [{ type: "text", text: errorText }], details: { error: true } },
      });

      const { step, text } = await onlyStep(owner, run.id);

      expect(step).toMatchObject({ kind: "tool", state: "error", summary: "Failed", change: null });
      for (const value of hidden) expect(text).not.toContain(value);
    });

    it("summarises the end step with the tool and approval counts of the whole run, whichever page holds it", async () => {
      const owner = await seededSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      await addCall(owner, run.id, "t1", { operation: "item.get" });
      await addToolUse(owner, run.id, "t2", { operation: "item.delete" });
      await addToolResult(owner, run.id, "t2", {
        operation: "item.delete",
        result: { content: [], details: { error: false, approvalRequestId: randomUUID() } },
      });
      await finish(owner, run.id);

      const first = await readPage(owner, run.id, queryOf(null, 2));
      const last = await readPage(owner, run.id, queryOf(first.nextCursor, 100));

      expect(first.steps.every((s) => s.kind !== "end")).toBe(true);
      expect(last.steps.find((s) => s.kind === "end")?.summary).toBe("2 tools, 1 approval");
    });

    it("answers with no target name for an item of another tenant and an id that is no uuid", async () => {
      const owner = await seededSession();
      const foreign = await createTask(await seededSession(), "Foreign task name");
      const run = await createRun(owner);
      await addCall(owner, run.id, "x1", patchIdentity(foreign));
      await addCall(owner, run.id, "x2", {
        operation: "item.get",
        targetItemId: "not-a-uuid",
        targetDatabaseId: "also-not",
      });

      const answer = await getSteps(owner, run.id);

      expect(answer.status).toBe(200);
      expect(pageSchema.parse(JSON.parse(answer.text)).steps.map((s) => [s.title, s.targetName])).toEqual([
        ["Changing an item", null],
        ["Reading an item", null],
      ]);
      expect(answer.text).not.toContain("Foreign task name");
    });

    it("looks the targets of a page up in the same number of queries for 3 steps as for 30", async () => {
      const owner = await seededSession();
      const task = await createTask(owner, "Counted");
      const queriesFor = async (calls: number): Promise<number> => {
        const run = await createRun(owner);
        await addStatus(owner, run.id, "running");
        for (let i = 0; i < calls; i++) await addCall(owner, run.id, `c${i}`, patchIdentity(task));
        return projectionQueries(owner, run.id, (steps) =>
          expect(steps.filter((s) => s.targetName === "Counted")).toHaveLength(calls),
        );
      };

      const few = await queriesFor(3);

      expect(few).toBeGreaterThan(0);
      expect(await queriesFor(30)).toBe(few);
    });
  });

  describe("approval state", () => {
    const SECRET = "execution-text-1862-never-returned";

    /** The result is stored as the runtime stores it. */
    async function addApprovalCall(session: Session, runId: string, requestId: string, toolCallId = "ask") {
      await addToolUse(session, runId, toolCallId, { operation: "item.delete" });
      await addToolResult(session, runId, toolCallId, {
        operation: "item.delete",
        result: {
          content: [{ type: "text", text: "awaiting a decision" }],
          details: { error: false, approvalRequestId: requestId },
        },
      });
    }

    async function runWithApprovalStep(session: Session, requestId: string): Promise<string> {
      const run = await createRun(session);
      await addStatus(session, run.id, "running");
      await addApprovalCall(session, run.id, requestId);
      return run.id;
    }

    function createRequest(session: Session, agentRunId: string): Promise<string> {
      return runInTenant(session.tenant, async () => {
        const request = await createPendingApprovalRequest(pool, {
          agentRunId,
          toolName: "probe",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: { secret: SECRET } },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        return request.id;
      });
    }

    async function decide(session: Session, requestId: string, decision: "approved" | "rejected"): Promise<void> {
      const res = await fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
        method: "PATCH",
        headers: { ...session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      expect(res.status).toBe(200);
    }

    async function pendingApproval(): Promise<{ session: Session; runId: string; requestId: string }> {
      const session = await tenantSession();
      const run = await createRun(session);
      const requestId = await createRequest(session, run.id);
      await addStatus(session, run.id, "running");
      await addApprovalCall(session, run.id, requestId);
      return { session, runId: run.id, requestId };
    }

    async function approvalStep(session: Session, runId: string) {
      const answer = await getSteps(session, runId);
      expect(answer.status, answer.text).toBe(200);
      expect(answer.text).not.toContain(SECRET);
      const step = pageSchema.parse(JSON.parse(answer.text)).steps.find((s) => s.kind === "approval");
      if (!step) throw new Error("The run has no approval step");
      return step;
    }

    it("reads the same step as pending, executing and executed as its request moves on, with no event written to the run", async () => {
      const { session, runId, requestId } = await pendingApproval();
      const eventsBefore = await runInTenant(session.tenant, () => listAgentRunEventsAfter(pool, runId, "0"));

      const pending = await approvalStep(session, runId);
      await decide(session, requestId, "approved");
      const executing = await approvalStep(session, runId);
      await runInTenant(session.tenant, () =>
        withTransaction(pool, (client) => markApprovalRequestExecutionSucceeded(client, requestId, { done: SECRET })),
      );
      const executed = await approvalStep(session, runId);

      expect(pending).toMatchObject({ approvalRequestId: requestId });
      expect(
        [pending, executing, executed].map((s) => [s.stepId, s.approvalState, s.state, "conflictReason" in s]),
      ).toEqual([
        [pending.stepId, "pending", "waitingApproval", false],
        [pending.stepId, "executing", "ok", false],
        [pending.stepId, "executed", "ok", false],
      ]);
      expect(await runInTenant(session.tenant, () => listAgentRunEventsAfter(pool, runId, "0"))).toEqual(eventsBefore);
    });

    const conflict = (details: Record<string, unknown>) => (session: Session, requestId: string) =>
      runInTenant(session.tenant, () =>
        withTransaction(pool, (client) =>
          terminalizeApprovalRequestAsConflict(client, requestId, { ...details, leaked: SECRET }),
        ),
      );
    it.each<
      [string, "approved" | "rejected", ((session: Session, requestId: string) => Promise<unknown>) | null, object]
    >([
      ["a rejected request as rejected", "rejected", null, { approvalState: "rejected", state: "ok" }],
      [
        "a conflict because the data changed before execution",
        "approved",
        conflict({}),
        { approvalState: "conflict", conflictReason: "approval.conflict.changed", state: "error" },
      ],
      [
        "a conflict because the source was deleted",
        "approved",
        conflict({ reason: "not_found" }),
        { approvalState: "conflict", conflictReason: "approval.conflict.deleted", state: "error" },
      ],
      [
        "a conflict because the database was archived",
        "approved",
        conflict({ reason: "database_archived" }),
        { approvalState: "conflict", conflictReason: "approval.conflict.archived", state: "error" },
      ],
      [
        "an MCP tool call that failed on execution as failed, without a conflict reason",
        "approved",
        async (session, requestId) =>
          expect(
            await runInTenant(session.tenant, () =>
              recordApprovalRequestOutcome(pool, requestId, { error: true, result: SECRET, outcomeKind: "callFailed" }),
            ),
          ).toBe(true),
        { approvalState: "failed", state: "error" },
      ],
    ])("shows %s", async (_name, decision, after, expected) => {
      const { session, runId, requestId } = await pendingApproval();
      await decide(session, requestId, decision);
      await after?.(session, requestId);

      const step = await approvalStep(session, runId);

      expect(step).toMatchObject(expected);
      expect("conflictReason" in step).toBe("conflictReason" in expected);
    });

    it("returns the page with no approval state for a step whose request does not exist, is no uuid or belongs to another tenant", async () => {
      const session = await tenantSession();
      const other = await pendingApproval();

      for (const requestId of [randomUUID(), "not-a-uuid", other.requestId]) {
        const step = await approvalStep(session, await runWithApprovalStep(session, requestId));
        expect(step).toMatchObject({ kind: "approval", approvalRequestId: requestId, state: "ok" });
        expect("approvalState" in step).toBe(false);
      }
    });

    it("reads the requests of a page in the same number of queries for one approval step as for five", async () => {
      const session = await tenantSession();
      const queriesFor = async (approvals: number): Promise<number> => {
        const run = await createRun(session);
        await addStatus(session, run.id, "running");
        for (let i = 0; i < approvals; i++) {
          await addApprovalCall(session, run.id, await createRequest(session, run.id), `ask${i}`);
        }
        return projectionQueries(session, run.id, (steps) =>
          expect(steps.filter((s) => s.approvalState === "pending")).toHaveLength(approvals),
        );
      };

      expect(await queriesFor(5)).toBe(await queriesFor(1));
    });
  });

  describe("limit and after", () => {
    it("pages 100 steps by default and up to 500 on request", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      for (let i = 0; i < 102; i++) await addMessage(owner, run.id, `message ${i}`);

      const byDefault = await readPage(owner, run.id);

      expect(byDefault.steps).toHaveLength(100);
      expect(byDefault.nextCursor).toBe(byDefault.steps[99]?.stepId);
      expect((await readPage(owner, run.id, "?limit=500")).steps).toHaveLength(102);
      expect((await readPage(owner, run.id, "?limit=1")).steps).toHaveLength(1);
    });

    it.each([
      ["a limit above 500", "?limit=501", "limit"],
      ["a limit of zero", "?limit=0", "limit"],
      ["a limit that is not a number", "?limit=ten", "limit"],
      ["a negative limit", "?limit=-1", "limit"],
      ["a fractional limit", "?limit=1.5", "limit"],
      ["an empty limit", "?limit=", "limit"],
      ["a repeated limit", "?limit=1&limit=2", "limit"],
      ["an after that is not a number", "?after=abc", "after"],
      ["a negative after", "?after=-1", "after"],
      ["a fractional after", "?after=1.5", "after"],
      ["an empty after", "?after=", "after"],
      ["a repeated after", "?after=1&after=2", "after"],
      ["an after beyond the id column", "?after=9223372036854775808", "after"],
      ["an after of twenty digits", "?after=10000000000000000000", "after"],
    ])("answers %s with 400 validation_failed naming the parameter", async (_label, query, field) => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");

      const answer = await getSteps(owner, run.id, query);

      expect(answer.status, answer.text).toBe(400);
      expect(JSON.parse(answer.text)).toMatchObject({ code: "validation_failed", details: { field } });
    });

    it("accepts the largest and smallest limit, an after of zero and the largest event id", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");

      for (const query of ["?limit=500", "?limit=1", "?after=0", "?after=9223372036854775807"]) {
        expect((await getSteps(owner, run.id, query)).status, query).toBe(200);
      }
    });

    it("answers a request for steps with a non-UUID run id with 400 and a non-GET method with 404", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);

      const post = await fetch(`${baseUrl}/api/agent-runs/${run.id}/steps`, { method: "POST", headers: owner.headers });

      expect((await getSteps(owner, "not-a-uuid")).status).toBe(400);
      expect(post.status).toBe(404);
    });
  });

  describe("authorization", () => {
    it("answers another tenant's run, an unknown run and a run of another actor with the same 404", async () => {
      const owner = await tenantSession();
      const stranger = await tenantSession();
      const run = await createRun(owner);
      await writeFinishedRun(owner, run.id);
      // A run's actor must be a user of its own tenant and the test tenant has one user, so the admin connection
      // skips the foreign key for this one run.
      const otherActorRun = await runInTenant(owner.tenant, () =>
        withTransaction(admin, async (client) => {
          await client.query("SET LOCAL session_replication_role = replica");
          const forged = await createAgentRun(client, { triggeredBy: "user", task: "probe", userId: stranger.userId });
          await insertAgentRunEvent(client, forged.id, "run_status", { kind: "run_status", status: "running" });
          return forged;
        }),
      );

      try {
        const foreignTenant = await getSteps(stranger, run.id);

        expect(foreignTenant).toEqual({ status: 404, text: '{"error":"Not found"}' });
        expect(await getSteps(owner, randomUUID())).toEqual(foreignTenant);
        expect(await getSteps(owner, otherActorRun.id)).toEqual(foreignTenant);
        expect((await readPage(owner, run.id)).steps).toHaveLength(6);
      } finally {
        await admin.query("DELETE FROM agent_run_events WHERE agent_run_id = $1", [otherActorRun.id]);
        await admin.query("DELETE FROM agent_runs WHERE id = $1", [otherActorRun.id]);
      }
    });

    it("rejects a request without a session", async () => {
      const run = await createRun(await tenantSession());

      expect((await fetch(`${baseUrl}/api/agent-runs/${run.id}/steps`)).status).toBe(401);
    });
  });

  describe("truncatedHistory", () => {
    it.each<[string, (session: Session, runId: string) => Promise<unknown>, boolean]>([
      ["false for a run that starts with its opening run_status", (s, id) => addStatus(s, id, "running"), false],
      [
        "true when the first stored event is not a run_status",
        async (s, id) => {
          await addMessage(s, id, "an answer");
          await addStatus(s, id, "running");
        },
        true,
      ],
      [
        "true when the first stored event is a run_status that does not open the run",
        (s, id) => addStatus(s, id, "done"),
        true,
      ],
    ])("is %s", async (_name, write, truncated) => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await write(owner, run.id);

      expect((await readPage(owner, run.id)).truncatedHistory).toBe(truncated);
    });

    it("is true, and the remaining steps are returned, when retention removed the run's earliest events", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner, { unit: "session" });
      const opening = await addStatus(owner, run.id, "running");
      await addMessage(owner, run.id, "an old answer");
      await addEvent(owner, run.id, "compaction", { kind: "compaction" });
      const kept = await addMessage(owner, run.id, "an answer after the checkpoint");
      await finish(owner, run.id);
      await runInTenant(owner.tenant, () =>
        pool.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [
          run.id,
          new Date(Date.now() - 40 * DAY_MS),
        ]),
      );
      expect((await readPage(owner, run.id)).truncatedHistory).toBe(false);

      const { deleted } = await handleAgentRunEventsRetentionTask(pool);
      const result = await readPage(owner, run.id);

      expect(deleted).toBe(2);
      expect(result.truncatedHistory).toBe(true);
      expect(result.steps.map((s) => [s.stepId, s.kind])).toContainEqual([kept.id, "answer"]);
      expect(result.steps.map((s) => s.stepId)).not.toContain(opening.id);
      expect(result.steps.at(-1)).toMatchObject({ kind: "end" });
    });

    it("is true for a finished run without any event and false for a running one", async () => {
      const owner = await tenantSession();
      const finished = await createRun(owner);
      await runInTenant(owner.tenant, () => finishAgentRun(pool, finished.id, "done", null));
      await settle(owner, finished.id);
      const running = await createRun(owner);

      expect(await readPage(owner, finished.id)).toEqual({ steps: [], nextCursor: null, truncatedHistory: true });
      expect(await readPage(owner, running.id)).toEqual({ steps: [], nextCursor: "0", truncatedHistory: false });
    });
  });

  describe("with ?messageId=", () => {
    const NOT_FOUND = { status: 404, body: { error: "Not found" } };

    const replySetup = (session: Session): ReplySetup => ({
      admin,
      pool,
      tenant: session.tenant,
      userId: session.userId,
    });

    /** A holds one tool call, B two; each has an answer, so A has 2 steps and B 3. */
    async function twoReplies(session: Session) {
      const setup = replySetup(session);
      const chat = await createChatRun(setup);
      const a = await playReply(setup, chat, { userText: "First", startMs: 0, toolCalls: [{ toolCallId: "call-a" }] });
      const b = await playReply(setup, chat, {
        userText: "Second",
        startMs: 10_000,
        toolCalls: [{ toolCallId: "call-b1" }, { toolCallId: "call-b2" }],
      });
      return { setup, chat, a, b };
    }

    const scoped = (messageId: string, rest = "") => `?messageId=${messageId}${rest}`;

    /** `refused` answers 404 exactly as an unknown message id does. */
    async function expectLikeUnknown(session: Session, runId: string, refused: string): Promise<string> {
      const answer = await getSteps(session, runId, scoped(refused));
      expect({ status: answer.status, body: JSON.parse(answer.text) }).toEqual(NOT_FOUND);
      expect(await getSteps(session, runId, scoped(randomUUID()))).toEqual(answer);
      return answer.text;
    }

    it("returns only the steps in each reply's events, a tool step with its result and its answer, and both without a messageId", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);

      const first = await readPage(owner, chat.runId, scoped(a.assistantMessageId));
      const second = await readPage(owner, chat.runId, scoped(b.assistantMessageId));
      const whole = await readPage(owner, chat.runId);

      expect(first.steps.map((step) => [step.stepId, step.kind, step.toolCallId, step.state])).toEqual([
        [a.eventIds[1], "tool", "call-a", "ok"],
        [a.eventIds[3], "answer", null, "ok"],
      ]);
      expect([first.nextCursor, first.truncatedHistory]).toEqual([null, false]);
      expect(second.steps.map((step) => [step.kind, step.toolCallId])).toEqual([
        ["tool", "call-b1"],
        ["tool", "call-b2"],
        ["answer", null],
      ]);
      expect(second.steps.map((step) => step.stepId).filter((id) => a.eventIds.includes(id))).toEqual([]);
      expect(second.nextCursor).toBeNull();
      expect(whole.steps.map((step) => step.toolCallId)).toEqual(["call-a", null, "call-b1", "call-b2", null]);
      expect(whole.steps.map((step) => step.stepId)).toEqual(
        expect.arrayContaining([a.eventIds[1], a.eventIds[3], b.eventIds[1], b.eventIds[3], b.eventIds[5]]),
      );
    });

    it("pages a reply with the cursor of the unscoped route, never splitting a call from its result nor leaving the reply", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);
      const unpaged = await readPage(owner, chat.runId, scoped(b.assistantMessageId));

      const pages = await readAllPages(owner, chat.runId, 1, scoped(b.assistantMessageId));
      const steps = pages.flatMap((page) => page.steps);

      expect(pages.map((page) => page.steps.length)).toEqual([1, 1, 1]);
      expect(steps).toEqual(unpaged.steps);
      expect(steps.filter((step) => step.kind === "tool").map((s) => s.durationMs)).toEqual([100, 100]);
      expect(steps.map((step) => step.stepId)).not.toContain(a.eventIds[1]);
    });

    it("starts at the later of the cursor and the reply's first event", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);

      const early = await readPage(owner, chat.runId, scoped(b.assistantMessageId, `&after=${a.firstEventId}`));
      const full = await readPage(owner, chat.runId, scoped(b.assistantMessageId));
      const done = await readPage(owner, chat.runId, scoped(b.assistantMessageId, `&after=${b.lastEventId}`));

      expect(early).toEqual(full);
      expect(done).toEqual({ steps: [], nextCursor: null, truncatedHistory: false });
    });

    it("keeps the cursor of a reply that is still running", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const running = await playReply(setup, chat, {
        userText: "First",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a" }],
        end: "running",
      });

      const page = await readPage(owner, chat.runId, scoped(running.assistantMessageId));

      expect(page.steps.map((step) => step.kind)).toEqual(["tool", "answer"]);
      // The reply may still store events, so a reader keeps the id of the last step's last event.
      expect(page.nextCursor).toBe(running.eventIds[3]);
    });

    it("shows a retried reply's latest attempt, whichever attempt the request names", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const first = await playReply(setup, chat, {
        userText: "Plan",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-1", fails: true }],
        end: "error",
      });
      const attemptId = await queueAssistantMessage(setup, chat, first.userMessageId);
      const second = await playQueuedAssistant(setup, chat, attemptId, {
        userMessageId: first.userMessageId,
        startMs: 5_000,
        toolCalls: [{ toolCallId: "call-2" }],
      });

      const named = await readPage(owner, chat.runId, scoped(first.assistantMessageId));
      const latest = await readPage(owner, chat.runId, scoped(second.assistantMessageId));

      expect(named).toEqual(latest);
      expect(latest.steps.map((step) => step.toolCallId)).toEqual(["call-2", null]);
    });

    it("ends a reply that stored no last event before the next reply's first event", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const failed = await playReply(setup, chat, {
        userText: "First",
        startMs: 0,
        toolCalls: [{ toolCallId: "call-a" }],
        end: "error",
      });
      const next = await playReply(setup, chat, {
        userText: "Second",
        startMs: 10_000,
        toolCalls: [{ toolCallId: "call-b" }],
      });

      const page = await readPage(owner, chat.runId, scoped(failed.assistantMessageId));

      expect(page.steps.map((step) => step.toolCallId)).toEqual(["call-a", null]);
      expect(page.steps.map((step) => step.stepId).filter((id) => next.eventIds.includes(id))).toEqual([]);
    });

    it("counts only the reply's own tool and approval steps in the summary of an end step inside its range", async () => {
      const owner = await tenantSession();
      await updateUserLocale(admin, owner.userId, "en");
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      await playReply(setup, chat, { userText: "First", startMs: 0, toolCalls: [{ toolCallId: "call-a" }] });
      const last = await playReply(setup, chat, {
        userText: "Second",
        startMs: 10_000,
        toolCalls: [{ toolCallId: "call-b1" }, { toolCallId: "call-b2" }],
        end: "error",
      });
      await createApproval(setup, chat.runId, "call-b1");
      // The last reply stored no last event, so the run's terminal event lies in its range.
      await finish(owner, chat.runId);

      const page = await readPage(owner, chat.runId, scoped(last.assistantMessageId));

      expect(page.steps.at(-1)).toMatchObject({ kind: "end", summary: "2 tools, no approvals" });
      const whole = await readPage(owner, chat.runId, "?limit=500");
      expect(whole.steps.at(-1)).toMatchObject({ kind: "end", summary: "3 tools, no approvals" });
    });

    describe("truncatedHistory", () => {
      it("is true, with no steps, when retention removed every event of the reply while the next reply's remain", async () => {
        const owner = await tenantSession();
        const setup = replySetup(owner);
        const chat = await createChatRun(setup);
        const a = await playReply(setup, chat, {
          userText: "First",
          startMs: 0,
          toolCalls: [{ toolCallId: "call-a" }],
        });
        const checkpoint = await addEvent(owner, chat.runId, "compaction", { kind: "compaction" });
        const b = await playReply(setup, chat, {
          userText: "Second",
          startMs: 10_000,
          toolCalls: [{ toolCallId: "call-b" }],
        });
        await finish(owner, chat.runId);
        await admin.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1 AND id <= $3::bigint", [
          chat.runId,
          new Date(Date.now() - 40 * DAY_MS),
          checkpoint.id,
        ]);
        expect(await readPage(owner, chat.runId, scoped(a.assistantMessageId))).toMatchObject({
          truncatedHistory: false,
        });

        const { deleted } = await handleAgentRunEventsRetentionTask(pool);
        const removed = await readPage(owner, chat.runId, scoped(a.assistantMessageId));
        const kept = await readPage(owner, chat.runId, scoped(b.assistantMessageId));

        expect(deleted).toBe(a.eventIds.length);
        expect(removed).toEqual({ steps: [], nextCursor: null, truncatedHistory: true });
        expect(kept.truncatedHistory).toBe(false);
        expect(kept.steps.map((step) => step.toolCallId)).toEqual(["call-b", null]);
      });

      it("is true, and the remaining steps are returned, when only the reply's first event is gone", async () => {
        const owner = await tenantSession();
        const { chat, a } = await twoReplies(owner);
        // Retention removes events before a checkpoint, never one alone; a lone removal gives the same state.
        await admin.query("DELETE FROM agent_run_events WHERE id = $1", [a.firstEventId]);

        const page = await readPage(owner, chat.runId, scoped(a.assistantMessageId));

        expect(page.truncatedHistory).toBe(true);
        expect(page.steps.map((step) => step.toolCallId)).toEqual(["call-a", null]);
      });
    });

    it("returns no step and no truncation for a reply that stored no event", async () => {
      const owner = await tenantSession();
      const { chat, a } = await twoReplies(owner);
      // No production write leaves a started reply without its first event id.
      await admin.query("UPDATE semp_messages SET event_from_id = NULL, event_to_id = NULL WHERE id = $1", [
        a.assistantMessageId,
      ]);

      expect(await readPage(owner, chat.runId, scoped(a.assistantMessageId))).toEqual({
        steps: [],
        nextCursor: null,
        truncatedHistory: false,
      });
    });

    it("answers a message of another run of the same tenant and one of another tenant like an unknown id", async () => {
      const owner = await tenantSession();
      const stranger = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      await playReply(setup, chat, { userText: "First", startMs: 0 });
      const other = await playReply(setup, await createChatRun(setup), { userText: "Elsewhere", startMs: 0 });
      const strangerSetup = replySetup(stranger);
      const foreignReply = await playReply(strangerSetup, await createChatRun(strangerSetup), {
        userText: "Private",
        startMs: 0,
      });

      await expectLikeUnknown(owner, chat.runId, other.assistantMessageId);
      const foreign = await expectLikeUnknown(owner, chat.runId, foreignReply.assistantMessageId);
      for (const id of foreignReply.eventIds) expect(foreign).not.toContain(id);
    });

    it("answers a message that is not an assistant message like an unknown id, even when it names the run", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const reply = await playReply(setup, chat, { userText: "First", startMs: 0 });
      // No production write gives a user message a run; set by SQL so only its role is refused.
      await admin.query("UPDATE semp_messages SET agent_run_id = $2 WHERE id = $1", [reply.userMessageId, chat.runId]);

      await expectLikeUnknown(owner, chat.runId, reply.userMessageId ?? "");
      expect((await getSteps(owner, chat.runId, scoped(reply.assistantMessageId))).status).toBe(200);
    });

    it.each([
      ["a messageId that is not a UUID", "?messageId=not-a-uuid"],
      ["an empty messageId", "?messageId="],
      ["a repeated messageId", `?messageId=${randomUUID()}&messageId=${randomUUID()}`],
    ])("answers %s with 400 validation_failed naming the field", async (_label, query) => {
      const owner = await tenantSession();
      const chat = await createChatRun(replySetup(owner));

      const answer = await getSteps(owner, chat.runId, query);

      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.text)).toMatchObject({ code: "validation_failed", details: { field: "messageId" } });
    });

    async function heartbeatRunWithMessage(
      session: Session,
      name: string,
    ): Promise<{ runId: string; tickThreadId: string; messageId: string }> {
      const projectItemId = await runInTenant(session.tenant, async () => {
        await seedSystem(pool, createViewTypeRegistry());
        const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
        if (!projects) throw new Error("The Projects database is missing");
        const project = await createChokePoint(pool).createItem({
          databaseId: projects.id,
          properties: { name: "Weekly review" },
        });
        return project.id;
      });
      const { heartbeatId, tickThreadId } = await runInTenant(session.tenant, () =>
        withTransaction(pool, async (client) => {
          const heartbeat = await createHeartbeat(client, {
            projectItemId,
            name,
            rule: { kind: "interval", minutes: 5 },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "Plan the week" },
          });
          const tick = await getOrCreateTickThread(client, heartbeat.id);
          return { heartbeatId: heartbeat.id, tickThreadId: tick.id };
        }),
      );
      const run = await createRun(session, {
        projectItemId,
        heartbeatId,
        threadId: tickThreadId,
        triggeredBy: "heartbeat",
      });
      await addStatus(session, run.id, "running");
      await addCall(session, run.id, "call-1", { operation: "item.get" });
      await addMessage(session, run.id, "Here is what I found");
      await runInTenant(session.tenant, () =>
        withTransaction(pool, (client) =>
          finishTickRunWithMessage(client, {
            thread: { id: tickThreadId, tenantId: session.tenant, heartbeatId },
            agentRunId: run.id,
            outcome: { status: "done", result: "ok" },
          }),
        ),
      );
      const message = await admin.query<{ id: string }>(
        "SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'assistant'",
        [tickThreadId],
      );
      const messageId = message.rows[0]?.id;
      if (messageId === undefined) throw new Error("The tick run stored no message");
      await addStatus(session, run.id, "done");
      await settle(session, run.id);
      return { runId: run.id, tickThreadId, messageId };
    }

    it("accepts the message of a heartbeat run and answers the steps of the whole run", async () => {
      const owner = await tenantSession();
      const { runId, messageId } = await heartbeatRunWithMessage(owner, "Sunday planning");

      const whole = await getSteps(owner, runId);

      expect(whole.status).toBe(200);
      expect(await getSteps(owner, runId, scoped(messageId))).toEqual(whole);
      expect(pageSchema.parse(JSON.parse(whole.text)).steps.map((step) => step.kind)).toEqual([
        "start",
        "tool",
        "answer",
        "end",
      ]);
      expect((await getSteps(owner, runId, scoped(randomUUID()))).status).toBe(404);
    });

    it("refuses for a heartbeat run, like an unknown id, another run's, another tenant's and a user message of its thread", async () => {
      const owner = await tenantSession();
      const run = await heartbeatRunWithMessage(owner, "Sunday planning");
      const other = await heartbeatRunWithMessage(owner, "Monday planning");
      const foreignRun = await heartbeatRunWithMessage(await tenantSession(), "Private planning");
      // No production write gives a user message a run; made by SQL so only its role is refused.
      const user = await admin.query<{ id: string }>(
        `INSERT INTO semp_messages (tenant_id, thread_id, role, text, agent_run_id)
         VALUES ($1, $2, 'user', 'Private question', $3) RETURNING id`,
        [owner.tenant, run.tickThreadId, run.runId],
      );
      const userMessageId = user.rows[0]?.id;
      if (userMessageId === undefined) throw new Error("The user message was not inserted");

      for (const refused of [other.messageId, foreignRun.messageId, userMessageId]) {
        await expectLikeUnknown(owner, run.runId, refused);
      }
      expect((await getSteps(owner, run.runId, scoped(run.messageId))).status).toBe(200);
    });
  });
});
