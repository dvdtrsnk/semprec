import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant, type SempMessageRef } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import {
  askQuestion,
  createChatSession,
  playAnswer,
  playQueuedAnswer,
  type AnswerSetup,
  type ChatSession,
} from "../../agentRuns/__tests__/chatAnswerFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTestProjectItem } from "../../testSupport/projectFixtures.js";
import { getOrCreateTickThread } from "../../testSupport/testDb.js";
import { createHeartbeat } from "../../scheduler/schedulerStore.js";
import { insertApprovalOutcomeSystemMessage } from "../sempMessagesStore.js";
import { validateSempMessageRefs } from "../sempMessageRefs.js";
import { readSempRefContext } from "../sempRefReadContext.js";
import { toolResultEvent, toolUseEvent } from "./sempReplyTestSupport.js";

interface TenantSetup {
  tenant: string;
  userId: string;
  projectItemId: string;
}

let admin: Pool;
let runtime: Pool;
let tenantA: TenantSetup;
let tenantB: TenantSetup;

const setupOf = (tenant: TenantSetup): AnswerSetup => ({
  admin,
  runtime,
  tenant: tenant.tenant,
  userId: tenant.userId,
});

async function createTenantSetup(): Promise<TenantSetup> {
  const tenant = await createTestTenant(admin);
  const user = await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" });
  const projectItemId = await runInTenant(tenant, () => createTestProjectItem(runtime));
  return { tenant, userId: user.id, projectItemId };
}

beforeAll(async () => {
  admin = getTestPool();
  await resetDatabase(admin);
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  tenantA = await createTenantSetup();
  tenantB = await createTenantSetup();
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

const ref = (agentRunId: string, messageId: string): SempMessageRef => ({ kind: "agentRun", agentRunId, messageId });

/**
 * Makes `messageIds` name `runId` as the run that produced them. Raw SQL on the admin pool, for states no writer
 * produces (a user message or a message of another thread that names the run), so the test reaches the role and thread
 * checks of the lookup on their own: every message a writer stores for another thread or role has no such run.
 */
async function nameRun(runId: string, messageIds: string[]): Promise<void> {
  const result = await admin.query("UPDATE semp_messages SET agent_run_id = $1 WHERE id = ANY($2::uuid[])", [
    runId,
    messageIds,
  ]);
  expect(result.rowCount).toBe(messageIds.length);
}

const validate = (tenant: TenantSetup, refs: SempMessageRef[]) =>
  runInTenant(tenant.tenant, () => withTransaction(runtime, (client) => validateSempMessageRefs(client, refs)));

const read = (tenant: TenantSetup, ref: SempMessageRef) =>
  runInTenant(tenant.tenant, () => withTransaction(runtime, (client) => readSempRefContext(client, ref)));

/** The error a validation raised, reduced to what a caller can observe of it. */
async function observedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      const { code, details } = error as Error & { code?: unknown; details?: unknown };
      return { name: error.name, message: error.message, code, details };
    }
    throw error;
  }
  throw new Error("The validation accepted the refs");
}

describe("an agentRun ref that names one answer (issue gh-1936)", () => {
  /** A chat run with three played answers; the second one calls a tool. */
  async function chatWithAnswers(tenant: TenantSetup) {
    const setup = setupOf(tenant);
    const session = await createChatSession(setup, tenant.projectItemId, { task: "Run task sentinel" });
    const call = { toolCallId: "call-1", name: "database_list", operation: "database.list" };
    const first = await playAnswer(setup, session, "First question sentinel", { startMs: 0, durationMs: 1000 });
    const second = await playAnswer(setup, session, "Second question sentinel", {
      startMs: 10_000,
      durationMs: 1000,
      toolEvents: [toolUseEvent(call, 100), toolResultEvent(call, 200)],
    });
    const third = await playAnswer(setup, session, "Third question sentinel", { startMs: 20_000, durationMs: 1000 });
    return { setup, session, first, second, third };
  }

  describe("validation", () => {
    it("accepts the assistant message of the run, in the order given, next to a ref of another whole run", async () => {
      const { session, first, second } = await chatWithAnswers(tenantA);
      const other = await chatWithAnswers(tenantA);
      const wholeRun: SempMessageRef = { kind: "agentRun", agentRunId: other.session.runId };
      const answer = (messageId: string): SempMessageRef => ({
        kind: "agentRun",
        agentRunId: session.runId,
        messageId,
      });

      const accepted = await validate(tenantA, [
        answer(second.assistantMessageId),
        wholeRun,
        { kind: "sleepNight", night: "2026-11-01" },
      ]);
      expect(accepted).toEqual([
        answer(second.assistantMessageId),
        wholeRun,
        { kind: "sleepNight", night: "2026-11-01" },
      ]);

      // Two answers of one chat run are two refs, and so are an answer and the whole run it belongs to: none is dropped.
      const wholeOfSession: SempMessageRef = { kind: "agentRun", agentRunId: session.runId };
      const both = [answer(first.assistantMessageId), answer(second.assistantMessageId)];
      expect(await validate(tenantA, both)).toEqual(both);
      expect(await validate(tenantA, [wholeOfSession, answer(first.assistantMessageId)])).toEqual([
        wholeOfSession,
        answer(first.assistantMessageId),
      ]);
      expect(await validate(tenantA, [answer(first.assistantMessageId), wholeOfSession])).toEqual([
        answer(first.assistantMessageId),
        wholeOfSession,
      ]);
      // The same answer posted twice is still one ref, the first one is kept.
      expect(
        await validate(tenantA, [
          answer(first.assistantMessageId),
          answer(second.assistantMessageId),
          answer(first.assistantMessageId),
        ]),
      ).toEqual(both);
    });

    it("refuses a message of another run, a user message, a message nobody wrote and a message of another tenant with the same error", async () => {
      const { session, first } = await chatWithAnswers(tenantA);
      const otherThread = await chatWithAnswers(tenantA);
      // A second run in the thread of the first one: the message belongs to the thread but was produced by the first run.
      const sameThreadRun = await createChatSession(setupOf(tenantA), tenantA.projectItemId, {
        threadId: session.threadId,
      });
      const queued = await askQuestion(setupOf(tenantA), session, "Not answered yet");
      const foreign = await chatWithAnswers(tenantB);
      const unthreadedRun = await runInTenant(tenantA.tenant, () =>
        createAgentRun(runtime, { triggeredBy: "user", unit: "session", task: "No thread", userId: tenantA.userId }),
      );
      await nameRun(session.runId, [first.userMessageId, otherThread.first.assistantMessageId]);
      const refusals: Array<[string, SempMessageRef]> = [
        ["a message of the thread of another run", ref(sameThreadRun.runId, first.assistantMessageId)],
        ["a message of another thread", ref(session.runId, otherThread.first.assistantMessageId)],
        ["a user message of the run's thread", ref(session.runId, first.userMessageId)],
        ["an assistant message that no run produced yet", ref(session.runId, queued.assistantMessageId)],
        ["an unknown message id", ref(session.runId, randomUUID())],
        ["a message of another tenant, with the run of this one", ref(session.runId, foreign.first.assistantMessageId)],
        ["a run of another tenant", ref(foreign.session.runId, foreign.first.assistantMessageId)],
        ["an unknown run id", ref(randomUUID(), first.assistantMessageId)],
        ["a run that has no thread", ref(unthreadedRun.id, first.assistantMessageId)],
      ];

      // The error the store already returns for a target that is not there: a run that does not exist.
      const unknownTarget = await observedError(validate(tenantA, [{ kind: "agentRun", agentRunId: randomUUID() }]));
      expect(unknownTarget).toMatchObject({ code: "validation_failed", details: { field: "context[0]" } });
      for (const [name, refusal] of refusals) {
        expect(await observedError(validate(tenantA, [refusal])), name).toEqual(unknownTarget);
      }
      // The refused ref is the one named by its index, whatever its neighbours are.
      expect(
        await observedError(
          validate(tenantA, [{ kind: "sleepNight", night: "2026-11-01" }, ref(session.runId, first.userMessageId)]),
        ),
      ).toMatchObject({ code: "validation_failed", details: { field: "context[1]" } });
    });

    it("accepts the answer of a tick thread's run and refuses a system message of it", async () => {
      const setup = setupOf(tenantA);
      const heartbeat = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, (client) =>
          createHeartbeat(client, {
            projectItemId: tenantA.projectItemId,
            name: "Morning review",
            rule: { kind: "interval", minutes: 5 },
            actionId: "noop",
          }),
        ),
      );
      const threadId = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, async (client) => (await getOrCreateTickThread(client, heartbeat.id)).id),
      );
      const session = await createChatSession(setup, tenantA.projectItemId, { threadId });
      const answered = await playAnswer(setup, session, "Why was the budget skipped?", { startMs: 0, durationMs: 100 });
      await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, (client) =>
          insertApprovalOutcomeSystemMessage(client, threadId, randomUUID(), "approval.outcome.executed", {}),
        ),
      );
      const { rows } = await admin.query<{ id: string }>(
        "SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'system'",
        [threadId],
      );
      expect(rows).toHaveLength(1);

      const systemMessageId = rows[0]?.id;
      if (systemMessageId === undefined) throw new Error("Expected a system message");
      await expect(validate(tenantA, [ref(session.runId, answered.assistantMessageId)])).resolves.toHaveLength(1);
      await expect(validate(tenantA, [ref(session.runId, systemMessageId)])).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "context[0]" },
      });
    });
  });

  describe("context", () => {
    it("holds the answer's question, result and steps and nothing of the rest of the session", async () => {
      const { session, first, second, third } = await chatWithAnswers(tenantA);

      const context = await read(tenantA, {
        kind: "agentRun",
        agentRunId: session.runId,
        messageId: second.assistantMessageId,
      });

      expect(context).toMatchObject({
        label: "Second question sentinel",
        state: "active",
        blob: null,
        details: { question: "Second question sentinel", systemKey: null, result: "reply", status: "done" },
      });
      const text = JSON.stringify(context);
      expect(text).toContain("database_list");
      for (const other of [first, third]) expect(text).not.toContain(other.userMessageId);
      for (const sentinel of ["First question sentinel", "Third question sentinel", "Run task sentinel"])
        expect(text).not.toContain(sentinel);
      expect(context?.details).toMatchObject({ truncated: false });
      expect(context?.details).toHaveProperty("steps");
      const steps = (context?.details as { steps: unknown }).steps;
      expect(Array.isArray(steps) && steps.length > 0).toBe(true);
      // The first answer called no tool, so its steps do not hold the second answer's.
      const firstContext = await read(tenantA, {
        kind: "agentRun",
        agentRunId: session.runId,
        messageId: first.assistantMessageId,
      });
      expect(JSON.stringify(firstContext)).not.toContain("database_list");
      expect(firstContext?.label).toBe("First question sentinel");
    });

    it("keeps the whole-run context of a ref without messageId", async () => {
      const { session } = await chatWithAnswers(tenantA);

      const context = await read(tenantA, { kind: "agentRun", agentRunId: session.runId });

      expect(context).toMatchObject({
        label: "Run task sentinel",
        details: { task: "Run task sentinel", status: "running", truncated: false },
      });
      expect(context?.details).not.toHaveProperty("question");
    });

    it("is unavailable for a message that is not an answer of the run, another tenant's, and an unknown one", async () => {
      const { session, first } = await chatWithAnswers(tenantA);
      const other = await chatWithAnswers(tenantA);
      const foreign = await chatWithAnswers(tenantB);
      const unthreadedRun = await runInTenant(tenantA.tenant, () =>
        createAgentRun(runtime, { triggeredBy: "user", unit: "session", task: "No thread", userId: tenantA.userId }),
      );
      // A second run in the thread of the first one: the message belongs to the thread but was produced by the first run.
      const sameThreadRun = await createChatSession(setupOf(tenantA), tenantA.projectItemId, {
        threadId: session.threadId,
      });
      await nameRun(session.runId, [first.userMessageId, other.first.assistantMessageId]);
      const unavailable: SempMessageRef[] = [
        { kind: "agentRun", agentRunId: sameThreadRun.runId, messageId: first.assistantMessageId },
        { kind: "agentRun", agentRunId: session.runId, messageId: other.first.assistantMessageId },
        { kind: "agentRun", agentRunId: session.runId, messageId: first.userMessageId },
        { kind: "agentRun", agentRunId: session.runId, messageId: randomUUID() },
        { kind: "agentRun", agentRunId: session.runId, messageId: foreign.first.assistantMessageId },
        { kind: "agentRun", agentRunId: unthreadedRun.id, messageId: first.assistantMessageId },
        { kind: "agentRun", agentRunId: randomUUID(), messageId: first.assistantMessageId },
      ];
      for (const ref of unavailable) expect(await read(tenantA, ref)).toBeNull();
      // The same refs, read in the tenant that owns the messages' run, are not reachable from the other tenant.
      expect(
        await read(tenantB, { kind: "agentRun", agentRunId: session.runId, messageId: first.assistantMessageId }),
      ).toBeNull();
    });

    it("gives the system key for an answer to a system message and no question", async () => {
      const setup = setupOf(tenantA);
      const heartbeat = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, (client) =>
          createHeartbeat(client, {
            projectItemId: tenantA.projectItemId,
            name: "System replies",
            rule: { kind: "interval", minutes: 5 },
            actionId: "noop",
          }),
        ),
      );
      const threadId = await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, async (client) => (await getOrCreateTickThread(client, heartbeat.id)).id),
      );
      const session = await createChatSession(setup, tenantA.projectItemId, { threadId, task: "Tick task" });
      await runInTenant(tenantA.tenant, () =>
        withTransaction(runtime, (client) =>
          insertApprovalOutcomeSystemMessage(client, threadId, randomUUID(), "approval.outcome.rejected", {}),
        ),
      );
      const queued = await admin.query<{ id: string }>(
        "SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'assistant' AND status = 'queued'",
        [threadId],
      );
      const messageId = queued.rows[0]?.id;
      if (messageId === undefined) throw new Error("Expected a queued assistant message");
      await playQueuedAnswer(setup, session, messageId, null, { startMs: 0, durationMs: 100 });

      const context = await read(tenantA, { kind: "agentRun", agentRunId: session.runId, messageId });

      expect(context).toMatchObject({
        label: "Tick task",
        details: { question: null, systemKey: "approval.outcome.rejected", result: "reply" },
      });
    });

    it("cuts a long question and result and flags it", async () => {
      const setup = setupOf(tenantA);
      const session: ChatSession = await createChatSession(setup, tenantA.projectItemId);
      const long = "q".repeat(8001);
      const answered = await playAnswer(setup, session, long, { startMs: 0, durationMs: 100 });

      const context = await read(tenantA, {
        kind: "agentRun",
        agentRunId: session.runId,
        messageId: answered.assistantMessageId,
      });

      const details = context?.details as { question: string; truncated: boolean };
      expect(details.question).toHaveLength(8000);
      expect(details.truncated).toBe(true);
      expect(context?.label).toHaveLength(120);
    });
  });
});
