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

/** A tenant with its user and that user's bearer header. */
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

/** Stores one event through the data owner's write and returns its id and stored time. */
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

/** Moves a finished run's `finished_at` back past the settle time, as a run that finished minutes ago has it. */
async function settle(session: Session, runId: string): Promise<void> {
  await runInTenant(session.tenant, () =>
    pool.query("UPDATE agent_runs SET finished_at = now() - interval '10 minutes' WHERE id = $1", [runId]),
  );
}

/** The opening event, a plan, two calls (one of an operation, one of an MCP tool), an answer and the end. */
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

describe("GET /api/agent-runs/:id/steps (issue #1821)", () => {
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
    it("groups a finished run into start, plan, two tool steps, answer and end without arguments, results or thinking", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await writeFinishedRun(owner, run.id);

      const answer = await getSteps(owner, run.id);
      const result = pageSchema.parse(JSON.parse(answer.text));

      expect(answer.status).toBe(200);
      expect(result.steps.map((s) => [s.kind, s.state])).toEqual([
        ["start", "ok"],
        ["plan", "ok"],
        ["tool", "ok"],
        ["tool", "ok"],
        ["answer", "ok"],
        ["end", "ok"],
      ]);
      expect(
        result.steps.filter((s) => s.kind === "tool").map((s) => [s.toolCallId, s.operation, s.mcp?.toolName]),
      ).toEqual([
        ["call-1", "item.get", undefined],
        ["call-2", null, "forecast"],
      ]);
      expect(result.nextCursor).toBeNull();
      expect(result.truncatedHistory).toBe(false);
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
      // The two times are database defaults, which a test cannot choose; pin them to see the subtraction.
      await runInTenant(owner.tenant, async () => {
        await pool.query("UPDATE agent_run_events SET at = $2 WHERE id = $1", [
          use.id,
          new Date("2026-11-01T10:00:00.000Z"),
        ]);
        await pool.query("UPDATE agent_run_events SET at = $2 WHERE id = $1", [
          result.id,
          new Date("2026-11-01T10:00:02.500Z"),
        ]);
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

      const pages: Page[] = [];
      let after: string | null = null;
      do {
        const next = await readPage(owner, run.id, queryOf(after, 2));
        pages.push(next);
        after = next.nextCursor;
      } while (after !== null && pages.length < 10);

      expect(pages.flatMap((p) => p.steps)).toEqual(unpaged.steps);
      expect(pages.map((p) => p.steps.length)).toEqual([2, 2, 2]);
      const replayOrder = events.map((e) => e.id);
      const stepIds = unpaged.steps.map((s) => s.stepId);
      expect(stepIds).toEqual(replayOrder.filter((id) => stepIds.includes(id)));
      // A page ends after a whole step: the cursors are the plan and the second call's result, never a tool_use.
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

      expect((await readPage(owner, run.id)).nextCursor).toBe("0");
      expect((await readPage(owner, run.id, `?after=${BigInt(use.id) - 1n}`)).nextCursor).toBe(
        String(BigInt(use.id) - 1n),
      );
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

      const first = await readPage(owner, run.id, "?limit=1");
      const second = await readPage(owner, run.id, queryOf(first.nextCursor, 1));
      const third = await readPage(owner, run.id, queryOf(second.nextCursor, 1));

      expect(first.steps.map((s) => s.kind)).toEqual(["start"]);
      expect(second.steps.map((s) => [s.toolCallId, s.state])).toEqual([
        ["a", "ok"],
        ["b", "ok"],
      ]);
      expect(third.steps.map((s) => s.kind)).toEqual(["end"]);
      expect(third.nextCursor).toBeNull();
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
      await addToolUse(owner, run.id, "call-2");
      await addToolResult(owner, run.id, "call-2");

      const { steps } = await readPage(owner, run.id);

      expect(steps.map((s) => [s.toolCallId, s.state])).toEqual([
        ["call-1", "error"],
        ["call-2", "ok"],
      ]);
    });

    it("reads the interrupted result that startup repair writes as an error step", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addToolUse(owner, run.id, "call-1");
      await addToolResult(owner, run.id, "call-1", {
        result: { content: [{ type: "text", text: "interrupted_by_restart" }], details: { error: true } },
        isError: true,
      });

      expect((await readPage(owner, run.id)).steps.map((s) => s.state)).toEqual(["error"]);
    });

    it("ends the cursor of a settled run whose terminal step was never stored, and not while it is fresh", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      const use = await addToolUse(owner, run.id, "call-1");
      await runInTenant(owner.tenant, () => finishAgentRun(pool, run.id, "error", "internal"));

      // The row was just closed and the terminal event may still be on its way.
      const fresh = await readPage(owner, run.id);
      expect(fresh.steps.map((s) => s.state)).toEqual(["ok", "running"]);
      expect(fresh.nextCursor).not.toBeNull();

      await settle(owner, run.id);
      const pages: Page[] = [];
      let after: string | null = null;
      do {
        const next = await readPage(owner, run.id, queryOf(after, 1));
        pages.push(next);
        after = next.nextCursor;
      } while (after !== null && pages.length < 10);

      expect(pages.flatMap((p) => p.steps).map((s) => [s.kind, s.state])).toEqual([
        ["start", "ok"],
        ["tool", "error"],
      ]);
      expect(pages.flatMap((p) => p.steps).map((s) => s.stepId)).toContain(use.id);
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
      await addStatus(owner, run.id, "running");
      const foreign = await addStatus(owner, other.id, "running");

      const { steps } = await readPage(owner, run.id);

      expect(steps.map((s) => s.stepId)).not.toContain(foreign.id);
      expect(steps).toHaveLength(1);
    });
  });

  describe("title, target, change and summary (issue #1847)", () => {
    const SECRET = "tok-1847-never-returned";

    /** A tenant with the system databases seeded, so it has a Tasks database, and a user of the given locale. */
    async function seededSession(locale: "cs" | "en" = "en"): Promise<Session> {
      const session = await tenantSession();
      await runInTenant(session.tenant, () => seedSystem(pool, createViewTypeRegistry()));
      // A new user reads Czech, so English is set as explicitly as Czech.
      await updateUserLocale(admin, session.userId, locale);
      return session;
    }

    /** The Tasks database of the tenant and a task of it with the given name, written through the choke point. */
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

    /** A finished item.patch call whose result reports changes, as the runtime stores it (issue #1527). */
    async function writePatchCall(session: Session, runId: string, task: { databaseId: string; itemId: string }) {
      await addStatus(session, runId, "running");
      await addToolUse(session, runId, "patch-1", { ...patchIdentity(task), name: "item_patch" });
      await addToolResult(session, runId, "patch-1", {
        ...patchIdentity(task),
        name: "item_patch",
        result: {
          content: [{ type: "text", text: `Patched ${SECRET}` }],
          details: { error: false, changes: [{ key: "status", before: "todo", after: "done" }] },
        },
      });
    }

    it("returns an item.patch on a task with its title, the task's name and the change, in English", async () => {
      const owner = await seededSession();
      const task = await createTask(owner, "Buy milk");
      const run = await createRun(owner);
      await writePatchCall(owner, run.id, task);

      const step = (await readPage(owner, run.id)).steps.find((s) => s.kind === "tool");

      expect(step).toMatchObject({
        operation: "item.patch",
        title: "Changing a task",
        targetName: "Buy milk",
        change: { property: "status", from: "todo", to: "done" },
        summary: "1 property changed",
        approvalRequestId: null,
      });
    });

    it("returns the same step in Czech for a user whose locale is cs", async () => {
      const owner = await seededSession("cs");
      const task = await createTask(owner, "Koupit mléko");
      const run = await createRun(owner);
      await writePatchCall(owner, run.id, task);

      const step = (await readPage(owner, run.id)).steps.find((s) => s.kind === "tool");

      expect(step).toMatchObject({
        title: "Změna úkolu",
        targetName: "Koupit mléko",
        change: { property: "status", from: "todo", to: "done" },
        summary: "Změněna 1 vlastnost",
      });
    });

    it("titles database.query and item.create over the task database in both locales", async () => {
      for (const [locale, titles] of [
        ["en", ["Searching tasks", "Creating a task"]],
        ["cs", ["Vyhledávání úkolů", "Vytvoření úkolu"]],
      ] as const) {
        const owner = await seededSession(locale);
        const task = await createTask(owner, "Any");
        const run = await createRun(owner);
        for (const [callId, operation] of [
          ["q", "database.query"],
          ["n", "item.create"],
        ] as const) {
          await addToolUse(owner, run.id, callId, { operation, targetDatabaseId: task.databaseId });
          await addToolResult(owner, run.id, callId, { operation, targetDatabaseId: task.databaseId });
        }

        const steps = (await readPage(owner, run.id)).steps;

        expect(
          steps.map((s) => [s.title, s.targetName]),
          locale,
        ).toEqual([
          [titles[0], null],
          [titles[1], null],
        ]);
      }
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

      const answer = await getSteps(owner, run.id);
      const step = pageSchema.parse(JSON.parse(answer.text)).steps[0];

      expect(step).toMatchObject({ title: "Using forecast", mcp: { serverName: "Weather" }, targetName: null });
      expect(answer.text).not.toContain(SECRET);
      expect(answer.text).not.toContain("sunny");
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

      const answer = await getSteps(owner, run.id);
      const step = pageSchema.parse(JSON.parse(answer.text)).steps[0];

      expect(step).toMatchObject({
        kind: "approval",
        state: "ok",
        approvalRequestId: requestId,
        title: "Deleting a task",
        targetName: "Old task",
        summary: "Approval requested",
      });
      expect(answer.text).not.toContain(SECRET);
      expect(answer.text).not.toContain("reason");
    });

    it("returns no raw error text of a failed call", async () => {
      const owner = await seededSession();
      const task = await createTask(owner, "Task");
      const run = await createRun(owner);
      await addToolUse(owner, run.id, "f1", patchIdentity(task));
      await addToolResult(owner, run.id, "f1", {
        ...patchIdentity(task),
        isError: true,
        result: { content: [{ type: "text", text: `validation_failed: ${SECRET}` }], details: { error: true } },
      });

      const answer = await getSteps(owner, run.id);
      const step = pageSchema.parse(JSON.parse(answer.text)).steps[0];

      expect(step).toMatchObject({ state: "error", summary: "Failed", change: null });
      expect(answer.text).not.toContain(SECRET);
      expect(answer.text).not.toContain("validation_failed");
    });

    it("returns a call interrupted by a restart, closed with an ordinary error result, as an error step", async () => {
      const owner = await seededSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      await addToolUse(owner, run.id, "i1", { operation: "item.get" });
      // The shape the startup repair of issue #1374 writes for a call without a result.
      await addToolResult(owner, run.id, "i1", {
        operation: "item.get",
        isError: true,
        result: { content: [{ type: "text", text: "interrupted_by_restart" }], details: { error: true } },
      });

      const answer = await getSteps(owner, run.id);
      const tool = pageSchema.parse(JSON.parse(answer.text)).steps.find((s) => s.kind === "tool");

      expect(tool).toMatchObject({ state: "error", summary: "Failed", operation: "item.get" });
      expect(answer.text).not.toContain("interrupted_by_restart");
    });

    it("returns no model text and no thinking for the plan and answer steps, with a title for each", async () => {
      const owner = await seededSession();
      const run = await createRun(owner);
      await writeFinishedRun(owner, run.id);

      const answer = await getSteps(owner, run.id);
      const steps = pageSchema.parse(JSON.parse(answer.text)).steps;

      expect(steps.map((s) => [s.kind, s.title])).toEqual([
        ["start", "Run started"],
        ["plan", "Planning"],
        ["tool", "Reading an item"],
        ["tool", "Using forecast"],
        ["answer", "Answering"],
        ["end", "Run finished"],
      ]);
      expect(answer.text).not.toContain("private reasoning");
      expect(answer.text).not.toContain("Let me look");
    });

    it("summarises the end step with the tool and approval counts of the whole run, whichever page holds it", async () => {
      const owner = await seededSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");
      await addToolUse(owner, run.id, "t1", { operation: "item.get" });
      await addToolResult(owner, run.id, "t1", { operation: "item.get" });
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
      const other = await seededSession();
      const foreign = await createTask(other, "Foreign task name");
      const run = await createRun(owner);
      await addToolUse(owner, run.id, "x1", patchIdentity(foreign));
      await addToolResult(owner, run.id, "x1", patchIdentity(foreign));
      const garbage = { operation: "item.get", targetItemId: "not-a-uuid", targetDatabaseId: "also-not" };
      await addToolUse(owner, run.id, "x2", garbage);
      await addToolResult(owner, run.id, "x2", garbage);

      const answer = await getSteps(owner, run.id);
      const steps = pageSchema.parse(JSON.parse(answer.text)).steps;

      expect(answer.status).toBe(200);
      expect(steps.map((s) => [s.title, s.targetName])).toEqual([
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
        for (let i = 0; i < calls; i++) {
          await addToolUse(owner, run.id, `c${i}`, patchIdentity(task));
          await addToolResult(owner, run.id, `c${i}`, patchIdentity(task));
        }
        return runInTenant(owner.tenant, () =>
          withTransaction(pool, async (client) => {
            const { events, hasMore } = await listAgentRunEventsForStepPage(client, run.id, "0", 100);
            const page = buildAgentRunStepPage({ events, hasMore, after: "0", limit: 100, runSettled: false });
            let queries = 0;
            const counting: PoolClient = new Proxy(client, {
              get(target, property) {
                if (property === "query") queries += 1;
                return Reflect.get(target, property);
              },
            });
            const projected = await projectAgentRunStepPage(counting, page, { agentRunId: run.id, locale: "en" });
            expect(projected.steps.filter((s) => s.targetName === "Counted")).toHaveLength(calls);
            return queries;
          }),
        );
      };

      const few = await queriesFor(3);
      const many = await queriesFor(30);

      expect(few).toBeGreaterThan(0);
      expect(many).toBe(few);
    });
  });

  describe("approval state (issue #1862)", () => {
    const SECRET = "execution-text-1862-never-returned";

    /** A run with one approval step whose call created `requestId`, as the runtime stores the result (issue #1527). */
    async function runWithApprovalStep(session: Session, requestId: string): Promise<string> {
      const run = await createRun(session);
      await addStatus(session, run.id, "running");
      await addToolUse(session, run.id, "ask", { operation: "item.delete" });
      await addToolResult(session, run.id, "ask", {
        operation: "item.delete",
        result: {
          content: [{ type: "text", text: "awaiting a decision" }],
          details: { error: false, approvalRequestId: requestId },
        },
      });
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

    /** A session with a run whose approval step points at a real, still pending request of the same run. */
    async function pendingApproval(): Promise<{ session: Session; runId: string; requestId: string }> {
      const session = await tenantSession();
      const run = await createRun(session);
      const requestId = await createRequest(session, run.id);
      await addStatus(session, run.id, "running");
      await addToolUse(session, run.id, "ask", { operation: "item.delete" });
      await addToolResult(session, run.id, "ask", {
        operation: "item.delete",
        result: { content: [], details: { error: false, approvalRequestId: requestId } },
      });
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

    it("shows a pending request as pending and the step as waiting for approval", async () => {
      const { session, runId, requestId } = await pendingApproval();

      const step = await approvalStep(session, runId);

      expect(step).toMatchObject({ approvalRequestId: requestId, approvalState: "pending", state: "waitingApproval" });
      expect("conflictReason" in step).toBe(false);
    });

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

      expect([pending, executing, executed].map((s) => [s.stepId, s.approvalState, s.state])).toEqual([
        [pending.stepId, "pending", "waitingApproval"],
        [pending.stepId, "executing", "ok"],
        [pending.stepId, "executed", "ok"],
      ]);
      const eventsAfter = await runInTenant(session.tenant, () => listAgentRunEventsAfter(pool, runId, "0"));
      expect(eventsAfter).toEqual(eventsBefore);
    });

    it("shows a rejected request as rejected", async () => {
      const { session, runId, requestId } = await pendingApproval();
      await decide(session, requestId, "rejected");

      expect(await approvalStep(session, runId)).toMatchObject({ approvalState: "rejected", state: "ok" });
    });

    it.each([
      ["the data changed before execution", {}, "approval.conflict.changed"],
      ["the source was deleted", { reason: "not_found" }, "approval.conflict.deleted"],
      ["the database was archived", { reason: "database_archived" }, "approval.conflict.archived"],
    ])(
      "shows an approved request that ended in a conflict (%s) as a conflict with its reason",
      async (_name, details, key) => {
        const { session, runId, requestId } = await pendingApproval();
        await decide(session, requestId, "approved");
        await runInTenant(session.tenant, () =>
          withTransaction(pool, (client) =>
            terminalizeApprovalRequestAsConflict(client, requestId, { ...details, leaked: SECRET }),
          ),
        );

        expect(await approvalStep(session, runId)).toMatchObject({
          approvalState: "conflict",
          conflictReason: key,
          state: "error",
        });
      },
    );

    it("shows a request whose MCP tool call failed on execution as failed, without a conflict reason", async () => {
      const { session, runId, requestId } = await pendingApproval();
      await decide(session, requestId, "approved");
      const written = await runInTenant(session.tenant, () =>
        recordApprovalRequestOutcome(pool, requestId, { error: true, result: SECRET, outcomeKind: "callFailed" }),
      );
      expect(written).toBe(true);

      const step = await approvalStep(session, runId);

      expect(step).toMatchObject({ approvalState: "failed", state: "error" });
      expect("conflictReason" in step).toBe(false);
    });

    it("returns the page with no approval state for a step whose request does not exist or is no uuid", async () => {
      const session = await tenantSession();
      const missing = await runWithApprovalStep(session, randomUUID());
      const garbage = await runWithApprovalStep(session, "not-a-uuid");

      for (const runId of [missing, garbage]) {
        const step = await approvalStep(session, runId);
        expect(step.state).toBe("ok");
        expect("approvalState" in step).toBe(false);
      }
    });

    it("does not read a request of another tenant", async () => {
      const owner = await tenantSession();
      const other = await pendingApproval();
      const runId = await runWithApprovalStep(owner, other.requestId);

      const step = await approvalStep(owner, runId);

      expect(step).toMatchObject({ kind: "approval", approvalRequestId: other.requestId, state: "ok" });
      expect("approvalState" in step).toBe(false);
    });

    it("reads the requests of a page in the same number of queries for one approval step as for five", async () => {
      const session = await tenantSession();
      const queriesFor = async (approvals: number): Promise<number> => {
        const run = await createRun(session);
        await addStatus(session, run.id, "running");
        for (let i = 0; i < approvals; i++) {
          const requestId = await createRequest(session, run.id);
          await addToolUse(session, run.id, `ask${i}`, { operation: "item.delete" });
          await addToolResult(session, run.id, `ask${i}`, {
            operation: "item.delete",
            result: { content: [], details: { error: false, approvalRequestId: requestId } },
          });
        }
        return runInTenant(session.tenant, () =>
          withTransaction(pool, async (client) => {
            const { events, hasMore } = await listAgentRunEventsForStepPage(client, run.id, "0", 100);
            const page = buildAgentRunStepPage({ events, hasMore, after: "0", limit: 100, runSettled: false });
            let queries = 0;
            const counting: PoolClient = new Proxy(client, {
              get(target, property) {
                if (property === "query") queries += 1;
                return Reflect.get(target, property);
              },
            });
            const projected = await projectAgentRunStepPage(counting, page, { agentRunId: run.id, locale: "en" });
            expect(projected.steps.filter((s) => s.approvalState === "pending")).toHaveLength(approvals);
            return queries;
          }),
        );
      };

      const one = await queriesFor(1);
      const five = await queriesFor(5);

      expect(five).toBe(one);
    });
  });

  describe("limit and after", () => {
    it("pages 100 steps by default and up to 500 on request", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      for (let i = 0; i < 102; i++) await addMessage(owner, run.id, `message ${i}`);

      const byDefault = await readPage(owner, run.id);
      const explicit = await readPage(owner, run.id, "?limit=500");
      const one = await readPage(owner, run.id, "?limit=1");

      expect(byDefault.steps).toHaveLength(100);
      expect(byDefault.nextCursor).toBe(byDefault.steps[99]?.stepId);
      expect(explicit.steps).toHaveLength(102);
      expect(one.steps).toHaveLength(1);
    });

    it.each([
      ["a limit above 500", "?limit=501"],
      ["a limit of zero", "?limit=0"],
      ["a limit that is not a number", "?limit=ten"],
      ["a negative limit", "?limit=-1"],
      ["a fractional limit", "?limit=1.5"],
      ["an empty limit", "?limit="],
      ["a repeated limit", "?limit=1&limit=2"],
      ["an after that is not a number", "?after=abc"],
      ["a negative after", "?after=-1"],
      ["a fractional after", "?after=1.5"],
      ["an empty after", "?after="],
      ["a repeated after", "?after=1&after=2"],
      ["an after beyond the id column", "?after=9223372036854775808"],
      ["an after of twenty digits", "?after=10000000000000000000"],
    ])("answers %s with 400 validation_failed", async (_label, query) => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");

      const answer = await getSteps(owner, run.id, query);

      expect(answer.status, answer.text).toBe(400);
      expect(JSON.parse(answer.text)).toMatchObject({ code: "validation_failed" });
    });

    it.each([
      ["the largest limit", "?limit=500"],
      ["the smallest limit", "?limit=1"],
      ["an after of zero", "?after=0"],
      ["the largest event id", "?after=9223372036854775807"],
    ])("accepts %s", async (_label, query) => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");

      expect((await getSteps(owner, run.id, query)).status).toBe(200);
    });

    it("names the offending parameter in the 400", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);

      const limit = JSON.parse((await getSteps(owner, run.id, "?limit=501")).text);
      const after = JSON.parse((await getSteps(owner, run.id, "?after=x")).text);

      expect(limit).toMatchObject({ details: { field: "limit" } });
      expect(after).toMatchObject({ details: { field: "after" } });
    });

    it("answers a request for steps with a non-UUID run id with 400 and a non-GET method with 404", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);

      const badId = await getSteps(owner, "not-a-uuid");
      const post = await fetch(`${baseUrl}/api/agent-runs/${run.id}/steps`, { method: "POST", headers: owner.headers });

      expect(badId.status).toBe(400);
      expect(post.status).toBe(404);
    });
  });

  describe("authorization", () => {
    it("answers another tenant's run, an unknown run and a run of another actor with the same 404", async () => {
      const owner = await tenantSession();
      const stranger = await tenantSession();
      const run = await createRun(owner);
      await writeFinishedRun(owner, run.id);
      // Raw fixture: a run's actor must be a user of its own tenant (agent_runs_actor_user_id_tenant_fkey) and the
      // test tenant has one user, so the admin connection skips the foreign key for this one run.
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
        const unknown = await getSteps(owner, randomUUID());
        const otherActor = await getSteps(owner, otherActorRun.id);
        const own = await readPage(owner, run.id);

        expect(foreignTenant).toEqual({ status: 404, text: '{"error":"Not found"}' });
        expect(unknown).toEqual(foreignTenant);
        expect(otherActor).toEqual(foreignTenant);
        expect(own.steps).toHaveLength(6);
      } finally {
        await admin.query("DELETE FROM agent_run_events WHERE agent_run_id = $1", [otherActorRun.id]);
        await admin.query("DELETE FROM agent_runs WHERE id = $1", [otherActorRun.id]);
      }
    });

    it("rejects a request without a session", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);

      const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}/steps`);

      expect(res.status).toBe(401);
    });
  });

  describe("truncatedHistory", () => {
    it("is false for a run that starts with its opening run_status", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "running");

      expect((await readPage(owner, run.id)).truncatedHistory).toBe(false);
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

    it("is true when the first stored event is not a run_status", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addMessage(owner, run.id, "an answer");
      await addStatus(owner, run.id, "running");

      expect((await readPage(owner, run.id)).truncatedHistory).toBe(true);
    });

    it("is true when the first stored event is a run_status that does not open the run", async () => {
      const owner = await tenantSession();
      const run = await createRun(owner);
      await addStatus(owner, run.id, "done");

      expect((await readPage(owner, run.id)).truncatedHistory).toBe(true);
    });

    it("is true for a finished run without any event and false for a running one", async () => {
      const owner = await tenantSession();
      const finished = await createRun(owner);
      await runInTenant(owner.tenant, () => finishAgentRun(pool, finished.id, "done", null));
      await settle(owner, finished.id);
      const running = await createRun(owner);

      const finishedPage = await readPage(owner, finished.id);
      const runningPage = await readPage(owner, running.id);

      expect(finishedPage).toEqual({ steps: [], nextCursor: null, truncatedHistory: true });
      expect(runningPage).toEqual({ steps: [], nextCursor: "0", truncatedHistory: false });
    });
  });

  describe("with ?messageId= (issue #1889)", () => {
    const NOT_FOUND = { status: 404, body: { error: "Not found" } };

    const replySetup = (session: Session): ReplySetup => ({
      admin,
      pool,
      tenant: session.tenant,
      userId: session.userId,
    });

    /** A chat run with two replies: A holds one tool call, B two. Each has an answer, so A has 2 steps and B 3. */
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

    it("returns only the steps in the first reply's events, a tool step with its result and its answer", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);

      const page = await readPage(owner, chat.runId, scoped(a.assistantMessageId));

      expect(page.steps.map((step) => [step.kind, step.toolCallId, step.state])).toEqual([
        ["tool", "call-a", "ok"],
        ["answer", null, "ok"],
      ]);
      const ids = page.steps.map((step) => step.stepId);
      expect(ids).toEqual([a.eventIds[1], a.eventIds[3]]);
      expect(ids.filter((id) => b.eventIds.includes(id))).toEqual([]);
      expect(page.nextCursor).toBeNull();
      expect(page.truncatedHistory).toBe(false);
    });

    it("returns only the steps in the second reply's events", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);

      const page = await readPage(owner, chat.runId, scoped(b.assistantMessageId));

      expect(page.steps.map((step) => [step.kind, step.toolCallId])).toEqual([
        ["tool", "call-b1"],
        ["tool", "call-b2"],
        ["answer", null],
      ]);
      expect(page.steps.map((step) => step.stepId).filter((id) => a.eventIds.includes(id))).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("returns the steps of both replies without a messageId, as for any run", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);

      const page = await readPage(owner, chat.runId);

      expect(page.steps.map((step) => step.toolCallId)).toEqual(["call-a", null, "call-b1", "call-b2", null]);
      expect(page.steps.map((step) => step.stepId)).toEqual(
        expect.arrayContaining([a.eventIds[1], a.eventIds[3], b.eventIds[1], b.eventIds[3], b.eventIds[5]]),
      );
    });

    it("pages a reply with the cursor of the unscoped route, never splitting a call from its result nor leaving the reply", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);
      const unpaged = await readPage(owner, chat.runId, scoped(b.assistantMessageId));

      const pages: Page[] = [];
      let after: string | null = null;
      do {
        const page: Page = await readPage(
          owner,
          chat.runId,
          scoped(b.assistantMessageId, after === null ? "&limit=1" : `&limit=1&after=${after}`),
        );
        pages.push(page);
        after = page.nextCursor;
      } while (after !== null);

      expect(pages.map((page) => page.steps.length)).toEqual([1, 1, 1]);
      expect(pages.flatMap((page) => page.steps)).toEqual(unpaged.steps);
      // A tool step is returned whole: its call and its result belong to one step with a duration.
      expect(
        pages
          .flatMap((page) => page.steps)
          .filter((step) => step.kind === "tool")
          .map((s) => s.durationMs),
      ).toEqual([100, 100]);
      expect(pages.flatMap((page) => page.steps).map((step) => step.stepId)).not.toContain(a.eventIds[1]);
    });

    it("starts at the later of the cursor and the reply's first event", async () => {
      const owner = await tenantSession();
      const { chat, a, b } = await twoReplies(owner);

      // A cursor inside reply A is before reply B's range, so B is still returned from its start.
      const early = await readPage(owner, chat.runId, scoped(b.assistantMessageId, `&after=${a.firstEventId}`));
      const full = await readPage(owner, chat.runId, scoped(b.assistantMessageId));
      // A cursor at the reply's last event leaves nothing to return.
      const done = await readPage(owner, chat.runId, scoped(b.assistantMessageId, `&after=${b.lastEventId}`));

      expect(early).toEqual(full);
      expect(done).toEqual({ steps: [], nextCursor: null, truncatedHistory: false });
    });

    it("keeps the cursor of a reply that is still running, and ends it for a finished one", async () => {
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
      // The run's terminal event follows the last reply, which stored no last event, so it lies in its range.
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
      // No production write leaves a started reply without its first event id; the column is cleared by SQL.
      await admin.query("UPDATE semp_messages SET event_from_id = NULL, event_to_id = NULL WHERE id = $1", [
        a.assistantMessageId,
      ]);

      const page = await readPage(owner, chat.runId, scoped(a.assistantMessageId));

      expect(page).toEqual({ steps: [], nextCursor: null, truncatedHistory: false });
    });

    it("answers a message of another run of the same tenant like an unknown id", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      await playReply(setup, chat, { userText: "First", startMs: 0 });
      const otherChat = await createChatRun(setup);
      const other = await playReply(setup, otherChat, { userText: "Elsewhere", startMs: 0 });

      const foreign = await getSteps(owner, chat.runId, scoped(other.assistantMessageId));
      const unknown = await getSteps(owner, chat.runId, scoped(randomUUID()));

      expect({ status: foreign.status, body: JSON.parse(foreign.text) }).toEqual(NOT_FOUND);
      expect(unknown).toEqual(foreign);
    });

    it("answers a message of another tenant like an unknown id", async () => {
      const owner = await tenantSession();
      const stranger = await tenantSession();
      const chat = await createChatRun(replySetup(owner));
      await playReply(replySetup(owner), chat, { userText: "First", startMs: 0 });
      const strangerChat = await createChatRun(replySetup(stranger));
      const foreignReply = await playReply(replySetup(stranger), strangerChat, { userText: "Private", startMs: 0 });

      const foreign = await getSteps(owner, chat.runId, scoped(foreignReply.assistantMessageId));
      const unknown = await getSteps(owner, chat.runId, scoped(randomUUID()));

      expect({ status: foreign.status, body: JSON.parse(foreign.text) }).toEqual(NOT_FOUND);
      expect(unknown).toEqual(foreign);
      for (const id of foreignReply.eventIds) expect(foreign.text).not.toContain(id);
    });

    it("answers a message that is not an assistant message like an unknown id, even when it names the run", async () => {
      const owner = await tenantSession();
      const setup = replySetup(owner);
      const chat = await createChatRun(setup);
      const reply = await playReply(setup, chat, { userText: "First", startMs: 0 });
      // No production write gives a user message a run; the link is set by SQL so that only its role is refused.
      await admin.query("UPDATE semp_messages SET agent_run_id = $2 WHERE id = $1", [reply.userMessageId, chat.runId]);

      const user = await getSteps(owner, chat.runId, scoped(reply.userMessageId ?? ""));
      const assistant = await getSteps(owner, chat.runId, scoped(reply.assistantMessageId));

      expect({ status: user.status, body: JSON.parse(user.text) }).toEqual(NOT_FOUND);
      expect(assistant.status).toBe(200);
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

    /**
     * A heartbeat run in a project of the tenant (seeded on first use) with one tool call, an answer and its one
     * assistant message in the tick thread.
     */
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
      await addToolUse(session, run.id, "call-1", { operation: "item.get" });
      await addToolResult(session, run.id, "call-1", { operation: "item.get" });
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
      const withMessage = await getSteps(owner, runId, scoped(messageId));
      const unknown = await getSteps(owner, runId, scoped(randomUUID()));

      expect(whole.status).toBe(200);
      expect(withMessage).toEqual(whole);
      expect(pageSchema.parse(JSON.parse(whole.text)).steps.map((step) => step.kind)).toEqual([
        "start",
        "tool",
        "answer",
        "end",
      ]);
      expect(unknown.status).toBe(404);
    });

    describe("a heartbeat run refuses a message that is not its own assistant message", () => {
      it("answers the assistant message of another run of the same tenant like an unknown id", async () => {
        const owner = await tenantSession();
        const run = await heartbeatRunWithMessage(owner, "Sunday planning");
        const other = await heartbeatRunWithMessage(owner, "Monday planning");

        const foreign = await getSteps(owner, run.runId, scoped(other.messageId));
        const unknown = await getSteps(owner, run.runId, scoped(randomUUID()));
        const own = await getSteps(owner, run.runId, scoped(run.messageId));

        expect({ status: foreign.status, body: JSON.parse(foreign.text) }).toEqual(NOT_FOUND);
        expect(unknown).toEqual(foreign);
        expect(own.status).toBe(200);
      });

      it("answers a user message of the run's thread like an unknown id, even when it names the run", async () => {
        const owner = await tenantSession();
        const run = await heartbeatRunWithMessage(owner, "Sunday planning");
        // No production write gives a user message a run; the row is made by SQL so that only its role is refused.
        const user = await admin.query<{ id: string }>(
          `INSERT INTO semp_messages (tenant_id, thread_id, role, text, agent_run_id)
           VALUES ($1, $2, 'user', 'Private question', $3) RETURNING id`,
          [owner.tenant, run.tickThreadId, run.runId],
        );
        const userMessageId = user.rows[0]?.id;
        if (userMessageId === undefined) throw new Error("The user message was not inserted");

        const refused = await getSteps(owner, run.runId, scoped(userMessageId));
        const own = await getSteps(owner, run.runId, scoped(run.messageId));

        expect({ status: refused.status, body: JSON.parse(refused.text) }).toEqual(NOT_FOUND);
        expect(own.status).toBe(200);
      });

      it("answers a message of another tenant like an unknown id", async () => {
        const owner = await tenantSession();
        const stranger = await tenantSession();
        const run = await heartbeatRunWithMessage(owner, "Sunday planning");
        const foreignRun = await heartbeatRunWithMessage(stranger, "Private planning");

        const foreign = await getSteps(owner, run.runId, scoped(foreignRun.messageId));
        const unknown = await getSteps(owner, run.runId, scoped(randomUUID()));

        expect({ status: foreign.status, body: JSON.parse(foreign.text) }).toEqual(NOT_FOUND);
        expect(unknown).toEqual(foreign);
      });
    });
  });
});
