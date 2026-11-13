import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  finishAgentRun,
  handleAgentRunEventsRetentionTask,
  hashPassword,
  insertAgentRunEvent,
  listAgentRunEventsAfter,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  withTransaction,
  type AgentRunEventKind,
  type AgentRunRow,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "agent-run-steps-password";
const DAY_MS = 24 * 60 * 60 * 1000;

const stepSchema = z.strictObject({
  stepId: z.string(),
  kind: z.enum(["start", "plan", "tool", "answer", "end", "error"]),
  state: z.enum(["running", "ok", "error"]),
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
});
