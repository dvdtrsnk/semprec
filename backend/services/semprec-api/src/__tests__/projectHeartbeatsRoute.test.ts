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
  claimSempMessage,
  CORE_AGENT_RUN_ACTION_ID,
  createAgentRun,
  createChainedAgentRun,
  createChokePoint,
  createHeartbeat,
  createPendingApprovalRequest,
  createUser,
  createViewTypeRegistry,
  finishAgentRun,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  getSystemSettingsItemId,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  recordHeartbeatFailure,
  seedSystem,
  sendSempMessage,
  setHeartbeatEnabled,
  startSempMessageTurn,
  succeedHeartbeatOccurrence,
  updateUserLocale,
  withTransaction,
  type AgentRunRow,
  type SempReplyStep,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "project-heartbeats-password";
const WEEKDAYS_AT_EIGHT_THIRTY = { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "08:30" } as const;

const lastOccurrenceSchema = z
  .object({
    at: z.string(),
    status: z.enum(["ok", "waiting_approval", "failed"]),
    errorSummary: z.string().nullable(),
  })
  .strict();

const heartbeatSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    rule: z.record(z.string(), z.unknown()),
    ruleLabel: z.string(),
    enabled: z.boolean(),
    nextFireAt: z.string().nullable(),
    lastOccurrence: lastOccurrenceSchema.nullable(),
    threadId: z.string().nullable(),
  })
  .strict();

const listSchema = z.object({ rows: z.array(heartbeatSchema) }).strict();
type ListedHeartbeat = z.infer<typeof heartbeatSchema>;

interface Session {
  tenant: string;
  userId: string;
  headers: { Authorization: string };
}

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

/** A tenant with its user, a seeded system and that user's bearer header. */
async function tenantSession(): Promise<Session> {
  const tenant = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword(PASSWORD) });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  return { tenant, userId: user.id, headers: { Authorization: `Bearer ${session.token}` } };
}

/** A Projects item of the tenant with the given name. */
function createProject(session: Session, name: string): Promise<string> {
  return runInTenant(session.tenant, async () => {
    const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!projects) throw new Error("The Projects database is missing");
    const project = await createChokePoint(pool).createItem({ databaseId: projects.id, properties: { name } });
    return project.id;
  });
}

interface NewHeartbeat {
  name: string;
  rule?: unknown;
  origin?: "user" | "system";
  enabled?: boolean;
}

/** One heartbeat in its own transaction, so `created_at` orders the heartbeats of a test as they were made. */
function createHeartbeatOf(session: Session, projectItemId: string, input: NewHeartbeat): Promise<string> {
  return runInTenant(session.tenant, () =>
    withTransaction(pool, async (client) => {
      const heartbeat = await createHeartbeat(client, {
        projectItemId,
        name: input.name,
        rule: input.rule ?? WEEKDAYS_AT_EIGHT_THIRTY,
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "Plan the week" },
        origin: input.origin ?? "user",
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
      return heartbeat.id;
    }),
  );
}

/**
 * One scheduled occurrence of a heartbeat. Raw SQL, because the production writer is the sweep, which inserts
 * a row only for a due time of the clock and so cannot produce a past occurrence at a chosen instant.
 */
function createOccurrence(session: Session, heartbeatId: string, scheduledFor: string): Promise<string> {
  return runInTenant(session.tenant, async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
       VALUES ($1, $2, $3::jsonb, 'queued') RETURNING id`,
      [heartbeatId, scheduledFor, JSON.stringify(WEEKDAYS_AT_EIGHT_THIRTY)],
    );
    const row = rows[0];
    if (!row) throw new Error("The occurrence was not inserted");
    return row.id;
  });
}

interface RunOf {
  projectItemId: string;
  heartbeatId: string;
  occurrenceId: string;
  attempt?: number;
  threadId?: string;
}

function createRunOf(session: Session, input: RunOf): Promise<AgentRunRow> {
  return runInTenant(session.tenant, () =>
    createAgentRun(pool, {
      userId: session.userId,
      projectItemId: input.projectItemId,
      heartbeatId: input.heartbeatId,
      heartbeatOccurrenceId: input.occurrenceId,
      attempt: input.attempt ?? 1,
      threadId: input.threadId ?? null,
      triggeredBy: "heartbeat",
      task: "Plan the week",
    }),
  );
}

function closeDone(session: Session, runId: string): Promise<boolean> {
  return runInTenant(session.tenant, () => finishAgentRun(pool, runId, "done", "finished"));
}

function closeFailed(session: Session, runId: string, errorCode: "modelError" | "budgetExceeded"): Promise<boolean> {
  return runInTenant(session.tenant, () => finishAgentRun(pool, runId, "error", errorCode));
}

/** The run of a new occurrence of the heartbeat, closed with `closing`. */
async function runOfOccurrence(
  session: Session,
  ids: { projectItemId: string; heartbeatId: string },
  scheduledFor: string,
  closing: "done" | "modelError" | "budgetExceeded" | "running",
): Promise<AgentRunRow> {
  const occurrenceId = await createOccurrence(session, ids.heartbeatId, scheduledFor);
  const run = await createRunOf(session, { ...ids, occurrenceId });
  if (closing === "done") await closeDone(session, run.id);
  else if (closing !== "running") await closeFailed(session, run.id, closing);
  return run;
}

function createRequest(session: Session, agentRunId: string): Promise<string> {
  return runInTenant(session.tenant, async () => {
    const request = await createPendingApprovalRequest(pool, {
      agentRunId,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
    return request.id;
  });
}

const STORED_STEP_TIMES = { startedAt: "2026-11-01T10:00:00.000Z", durationMs: 5 };

/** A stored tool step of an MCP call that failed with `failureKind`, as the projector of issue #1860 writes it. */
function failedMcpStep(failureKind: string): SempReplyStep {
  return {
    kind: "tool",
    toolCallId: "call-1",
    toolName: "mcp_search_aaaaaaaa",
    label: { key: "agentStep.title.namedTool", params: { toolName: "search" } },
    detail: { key: "agentStep.summary.failed", params: {} },
    status: "error",
    errorCode: failureKind,
    connectorName: "GitHub",
    ...STORED_STEP_TIMES,
  };
}

/** Gives `run` (still running) the single reply of its tick thread, finished as `done` with `steps`, and closes the run as done. */
async function finishRunWithReply(session: Session, run: AgentRunRow, steps: SempReplyStep[]): Promise<void> {
  const threadId = run.threadId;
  if (threadId === null) throw new Error("The run has no thread");
  await runInTenant(session.tenant, async () => {
    const event = await insertAgentRunEvent(pool, run.id, "user_message", {
      kind: "user_message",
      text: "tick",
      context: [],
    });
    await withTransaction(pool, async (client) => {
      const sent = await sendSempMessage(client, { threadId, text: "tick", context: [], hasContext: false });
      await claimSempMessage(client, threadId, sent.assistantMessageId);
      await startSempMessageTurn(client, sent.assistantMessageId, run.id, event.id);
      const stored = await finishSempMessageTurn(client, sent.assistantMessageId, {
        status: "done",
        text: "The answer.",
        lastEventId: event.id,
        summary: { steps, durationMs: null, tokens: { input: 0, output: 0 }, changes: [] },
      });
      expect(stored).toBe(true);
    });
    await finishAgentRun(pool, run.id, "done", "finished");
  });
}

function tickThreadOf(session: Session, heartbeatId: string): Promise<string> {
  return runInTenant(session.tenant, () =>
    withTransaction(pool, async (client) => (await getOrCreateTickThread(client, heartbeatId)).id),
  );
}

async function getAnswer(session: Session | null, projectId: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/heartbeats`, {
    headers: session ? session.headers : {},
  });
  return { status: res.status, text: await res.text() };
}

async function listHeartbeats(session: Session, projectId: string): Promise<ListedHeartbeat[]> {
  const answer = await getAnswer(session, projectId);
  expect(answer.status, answer.text).toBe(200);
  return listSchema.parse(JSON.parse(answer.text)).rows;
}

async function onlyHeartbeat(session: Session, projectId: string): Promise<ListedHeartbeat> {
  const rows = await listHeartbeats(session, projectId);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("The list is empty");
  return row;
}

function setLocale(session: Session, locale: "cs" | "en"): Promise<unknown> {
  return updateUserLocale(admin, session.userId, locale);
}

/** The time of day of `isoInstant` on the wall clock of `timeZone`, as `HH:MM`. */
function wallClockIn(timeZone: string, isoInstant: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(isoInstant),
  );
}

describe("GET /api/projects/:id/heartbeats (issue gh-1910)", () => {
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
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-project-heartbeats-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });

  describe("which heartbeats are listed", () => {
    it("lists exactly the three user automations of the project, oldest first, and none of the system ones", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const otherProject = await createProject(owner, "Another project");
      const watched = (
        await runInTenant(owner.tenant, () => createChokePoint(pool).createDatabase({ name: "Watched" }))
      ).id;
      const first = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const second = await createHeartbeatOf(owner, project, {
        name: "Daily digest",
        rule: { kind: "dailyTime", at: "18:00" },
      });
      const third = await createHeartbeatOf(owner, project, {
        name: "Heartbeat check",
        rule: { kind: "interval", minutes: 90 },
        enabled: false,
      });
      // The system's own: a time-based one and an onItemEvent one named as the seeded new-email automation is.
      await createHeartbeatOf(owner, project, { name: "Nightly sweep", origin: "system" });
      await createHeartbeatOf(owner, project, {
        name: "newEmail",
        origin: "system",
        rule: { kind: "onItemEvent", databaseId: watched, event: "create" },
      });
      // A user automation of another project is that project's.
      await createHeartbeatOf(owner, otherProject, { name: "Someone else's" });

      const rows = await listHeartbeats(owner, project);

      expect(rows.map((row) => row.id)).toEqual([first, second, third]);
      expect(rows.map((row) => row.name)).toEqual(["Monday plan", "Daily digest", "Heartbeat check"]);
      expect(rows.map((row) => row.enabled)).toEqual([true, true, false]);
      expect(rows[0]!.rule).toEqual(WEEKDAYS_AT_EIGHT_THIRTY);
      expect(rows[1]!.rule).toEqual({ kind: "dailyTime", at: "18:00" });
      expect(rows[2]!.rule).toEqual({ kind: "interval", minutes: 90 });
      // The next due time is the stored one: set for the two switched on, none for the one switched off.
      expect(rows.map((row) => row.nextFireAt === null)).toEqual([false, false, true]);
      // Nothing has run, so there is no last occurrence and no tick thread yet.
      expect(rows.every((row) => row.lastOccurrence === null && row.threadId === null)).toBe(true);
    });

    it("lists nothing for a project without user automations", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Empty");
      await createHeartbeatOf(owner, project, { name: "System only", origin: "system" });

      expect(await listHeartbeats(owner, project)).toEqual([]);
    });

    it("gives the tick thread of an automation that has run and null for one that has not", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const ran = await createHeartbeatOf(owner, project, { name: "Ran" });
      await createHeartbeatOf(owner, project, { name: "Never ran" });
      const threadId = await tickThreadOf(owner, ran);

      const rows = await listHeartbeats(owner, project);

      expect(rows.map((row) => row.threadId)).toEqual([threadId, null]);
    });
  });

  describe("the rule label", () => {
    it("renders Monday to Friday at 08:30 in the language of the user: Czech by default, English on request", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      await createHeartbeatOf(owner, project, { name: "Monday plan" });

      expect((await onlyHeartbeat(owner, project)).ruleLabel).toBe("Po-Pá v 8:30");
      await setLocale(owner, "en");
      expect((await onlyHeartbeat(owner, project)).ruleLabel).toBe("Mon-Fri at 8:30");
    });

    it("reads the time of day in the system timezone: the label and the next due time follow the setting together", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const before = await onlyHeartbeat(owner, project);

      await runInTenant(owner.tenant, async () => {
        const settingsItemId = await withTransaction(pool, (client) => getSystemSettingsItemId(client));
        const { rows } = await pool.query<{ database_id: string }>("SELECT database_id FROM items WHERE id = $1", [
          settingsItemId,
        ]);
        const databaseId = rows[0]?.database_id;
        if (!databaseId) throw new Error("The system settings row is missing");
        await createChokePoint(pool).updateItem({
          databaseId,
          itemId: settingsItemId,
          propertiesPatch: { timezone: "America/New_York" },
        });
      });
      const after = await onlyHeartbeat(owner, project);

      // The seeded zone is Europe/Prague: both due times are 08:30 on the clock of the zone in force when they
      // were computed, and the label states that clock time in both.
      expect(wallClockIn("Europe/Prague", before.nextFireAt!)).toBe("08:30");
      expect(wallClockIn("America/New_York", after.nextFireAt!)).toBe("08:30");
      expect(after.nextFireAt).not.toBe(before.nextFireAt);
      expect(before.ruleLabel).toBe("Po-Pá v 8:30");
      expect(after.ruleLabel).toBe("Po-Pá v 8:30");
    });

    it("reads a rule of a kind no module registers as a custom schedule instead of failing the list", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const moduleKinds = new Map([
        [
          "fixtureGood.onWidgetTick",
          {
            schema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
            nextFireAt: (_rule: unknown, _timezone: string, after: Date) => new Date(after.getTime() + 60_000),
          },
        ],
      ]);
      await runInTenant(owner.tenant, () =>
        withTransaction(pool, (client) =>
          createHeartbeat(
            client,
            {
              projectItemId: project,
              name: "Widget tick",
              rule: { kind: "fixtureGood.onWidgetTick", everyMinutes: 5 },
              actionId: CORE_AGENT_RUN_ACTION_ID,
              actionConfig: { task: "Tick" },
              origin: "user",
            },
            moduleKinds,
          ),
        ),
      );

      const row = await onlyHeartbeat(owner, project);

      expect(row.ruleLabel).toBe("Vlastní plán");
      expect(row.rule).toEqual({ kind: "fixtureGood.onWidgetTick", everyMinutes: 5 });
    });
  });

  describe("the last occurrence", () => {
    it("is the status ok of a run that finished, at the time the occurrence was due", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      await runOfOccurrence(owner, { projectItemId: project, heartbeatId }, "2026-11-10T07:30:00.000Z", "done");

      const row = await onlyHeartbeat(owner, project);

      expect(row.lastOccurrence).toEqual({ at: "2026-11-10T07:30:00.000Z", status: "ok", errorSummary: null });
    });

    it("is waiting_approval when the latest run is waiting for an approval, and ok again once it is decided", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const run = await runOfOccurrence(
        owner,
        { projectItemId: project, heartbeatId },
        "2026-11-10T07:30:00.000Z",
        "done",
      );
      const requestId = await createRequest(owner, run.id);

      const waiting = await onlyHeartbeat(owner, project);
      const decision = await fetch(`${baseUrl}/api/approval-requests/${requestId}`, {
        method: "PATCH",
        headers: { ...owner.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      expect(decision.status).toBe(200);
      const decided = await onlyHeartbeat(owner, project);

      // The occurrence itself succeeded in both: only the run's display status tells them apart.
      expect(waiting.lastOccurrence).toEqual({
        at: "2026-11-10T07:30:00.000Z",
        status: "waiting_approval",
        errorSummary: null,
      });
      expect(decided.lastOccurrence).toMatchObject({ status: "ok" });
    });

    it("is failed with the localized summary of the error code of the run, in the language of the user", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      await runOfOccurrence(owner, { projectItemId: project, heartbeatId }, "2026-11-10T07:30:00.000Z", "modelError");

      const czech = await onlyHeartbeat(owner, project);
      await setLocale(owner, "en");
      const english = await onlyHeartbeat(owner, project);

      expect(czech.lastOccurrence).toEqual({
        at: "2026-11-10T07:30:00.000Z",
        status: "failed",
        errorSummary: "Chyba AI modelu",
      });
      expect(english.lastOccurrence).toEqual({
        at: "2026-11-10T07:30:00.000Z",
        status: "failed",
        errorSummary: "AI model error",
      });
    });

    it("is read from the run, not from the occurrence's status or the raw errors stored on the heartbeat", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const run = await runOfOccurrence(
        owner,
        { projectItemId: project, heartbeatId },
        "2026-11-10T07:30:00.000Z",
        "budgetExceeded",
      );
      const rawError = "connect ECONNREFUSED 10.0.0.7:5432 token=raw-secret-value";
      await runInTenant(owner.tenant, async () => {
        // The fire task of a run that failed still ends as a succeeded occurrence, and the queue keeps the raw text.
        await withTransaction(pool, async (client) => {
          await succeedHeartbeatOccurrence(client, run.heartbeatOccurrenceId!);
          await recordHeartbeatFailure(client, heartbeatId, rawError);
        });
      });

      const answer = await getAnswer(owner, project);

      const occurrence = await admin.query<{ status: string }>(
        "SELECT status FROM heartbeat_occurrences WHERE id = $1",
        [run.heartbeatOccurrenceId],
      );
      expect(occurrence.rows).toEqual([{ status: "succeeded" }]);
      expect(answer.text).not.toContain("raw-secret-value");
      expect(answer.text).not.toContain("ECONNREFUSED");
      expect(listSchema.parse(JSON.parse(answer.text)).rows[0]!.lastOccurrence).toEqual({
        at: "2026-11-10T07:30:00.000Z",
        status: "failed",
        errorSummary: "Rozpočet na AI vyčerpán",
      });
    });

    it("is failed for a disabled automation whose last run failed, which stays disabled", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      await runOfOccurrence(owner, { projectItemId: project, heartbeatId }, "2026-11-10T07:30:00.000Z", "modelError");
      await runInTenant(owner.tenant, () =>
        withTransaction(pool, (client) => setHeartbeatEnabled(client, heartbeatId, false)),
      );

      const row = await onlyHeartbeat(owner, project);

      expect(row.enabled).toBe(false);
      expect(row.nextFireAt).toBeNull();
      expect(row.lastOccurrence).toEqual({
        at: "2026-11-10T07:30:00.000Z",
        status: "failed",
        errorSummary: "Chyba AI modelu",
      });
    });

    it("is failed, with the summary naming the server, for a run that finished with a failed tool call in its reply", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const threadId = await tickThreadOf(owner, heartbeatId);
      const occurrenceId = await createOccurrence(owner, heartbeatId, "2026-11-10T07:30:00.000Z");
      const run = await createRunOf(owner, { projectItemId: project, heartbeatId, occurrenceId, threadId });
      await finishRunWithReply(owner, run, [failedMcpStep("unavailable")]);

      const row = await onlyHeartbeat(owner, project);

      expect(row.lastOccurrence).toEqual({
        at: "2026-11-10T07:30:00.000Z",
        status: "failed",
        errorSummary: "GitHub není dostupný",
      });
      expect(row.threadId).toBe(threadId);
    });

    it("is ok for a run whose reply left no failed tool call", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const threadId = await tickThreadOf(owner, heartbeatId);
      const occurrenceId = await createOccurrence(owner, heartbeatId, "2026-11-10T07:30:00.000Z");
      const run = await createRunOf(owner, { projectItemId: project, heartbeatId, occurrenceId, threadId });
      await finishRunWithReply(owner, run, []);

      expect((await onlyHeartbeat(owner, project)).lastOccurrence).toMatchObject({ status: "ok", errorSummary: null });
    });

    it("is the occurrence due last, not the one whose run was created last", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const ids = { projectItemId: project, heartbeatId };
      await runOfOccurrence(owner, ids, "2026-11-11T07:30:00.000Z", "done");
      await runOfOccurrence(owner, ids, "2026-11-10T07:30:00.000Z", "modelError");

      expect((await onlyHeartbeat(owner, project)).lastOccurrence).toEqual({
        at: "2026-11-11T07:30:00.000Z",
        status: "ok",
        errorSummary: null,
      });
    });

    it("is the status of the last attempt of the occurrence: a retry that succeeded makes it ok", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const first = await runOfOccurrence(
        owner,
        { projectItemId: project, heartbeatId },
        "2026-11-10T07:30:00.000Z",
        "modelError",
      );
      const retry = await runInTenant(owner.tenant, () =>
        createChainedAgentRun(pool, {
          projectItemId: project,
          heartbeatId,
          heartbeatOccurrenceId: first.heartbeatOccurrenceId,
          retryOfRunId: first.id,
          attempt: 2,
          triggeredBy: "heartbeat",
          task: "Plan the week",
        }),
      );
      expect(retry).not.toBeNull();
      // While the retry runs, the occurrence has no finished last attempt and the failed first one does not stand for it.
      expect((await onlyHeartbeat(owner, project)).lastOccurrence).toBeNull();
      await closeDone(owner, retry!.id);

      expect((await onlyHeartbeat(owner, project)).lastOccurrence).toMatchObject({ status: "ok", errorSummary: null });
    });

    it("passes over an occurrence that has no run and one whose run is still running, to the last that finished", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const ids = { projectItemId: project, heartbeatId };
      await runOfOccurrence(owner, ids, "2026-11-08T07:30:00.000Z", "modelError");
      await runOfOccurrence(owner, ids, "2026-11-09T07:30:00.000Z", "running");
      await createOccurrence(owner, heartbeatId, "2026-11-10T07:30:00.000Z");

      expect((await onlyHeartbeat(owner, project)).lastOccurrence).toEqual({
        at: "2026-11-08T07:30:00.000Z",
        status: "failed",
        errorSummary: "Chyba AI modelu",
      });
    });

    it("is null for an automation whose only occurrence has no run yet or is still running", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const queued = await createHeartbeatOf(owner, project, { name: "Queued" });
      const running = await createHeartbeatOf(owner, project, { name: "Running" });
      await createOccurrence(owner, queued, "2026-11-10T07:30:00.000Z");
      await runOfOccurrence(
        owner,
        { projectItemId: project, heartbeatId: running },
        "2026-11-10T07:30:00.000Z",
        "running",
      );

      const rows = await listHeartbeats(owner, project);

      expect(rows.map((row) => row.lastOccurrence)).toEqual([null, null]);
    });

    it("keeps each automation's own last occurrence when several have run", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const good = await createHeartbeatOf(owner, project, { name: "Good" });
      const bad = await createHeartbeatOf(owner, project, { name: "Bad" });
      await runOfOccurrence(owner, { projectItemId: project, heartbeatId: good }, "2026-11-10T07:30:00.000Z", "done");
      await runOfOccurrence(
        owner,
        { projectItemId: project, heartbeatId: bad },
        "2026-11-09T07:30:00.000Z",
        "modelError",
      );

      const rows = await listHeartbeats(owner, project);

      expect(rows.map((row) => [row.name, row.lastOccurrence?.status, row.lastOccurrence?.at])).toEqual([
        ["Good", "ok", "2026-11-10T07:30:00.000Z"],
        ["Bad", "failed", "2026-11-09T07:30:00.000Z"],
      ]);
    });
  });

  describe("what the route refuses", () => {
    it("answers 404 for another tenant's project exactly as for an id that does not exist", async () => {
      const owner = await tenantSession();
      const stranger = await tenantSession();
      const strangerProject = await createProject(stranger, "Stranger's project");
      await createHeartbeatOf(stranger, strangerProject, { name: "Stranger's automation" });

      const foreign = await getAnswer(owner, strangerProject);
      const random = await getAnswer(owner, randomUUID());

      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(random.text);
      expect(foreign.text).not.toContain("Stranger's automation");
      // The owner of the project still gets its automation, so the 404 above is a refusal and not an empty route.
      expect((await listHeartbeats(stranger, strangerProject)).map((row) => row.name)).toEqual([
        "Stranger's automation",
      ]);
    });

    it("answers 404 for a project in the trash", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      await createHeartbeatOf(owner, project, { name: "Monday plan" });
      const trashed = await fetch(`${baseUrl}/api/items/${project}`, { method: "DELETE", headers: owner.headers });
      expect(trashed.status).toBeLessThan(300);

      expect((await getAnswer(owner, project)).status).toBe(404);
    });

    it("answers 404 for an item that is not a project", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");
      const heartbeatId = await createHeartbeatOf(owner, project, { name: "Monday plan" });

      // A heartbeat's id is the id of no project.
      expect((await getAnswer(owner, heartbeatId)).status).toBe(404);
    });

    it("answers 400 naming the field for an id that is not a UUID", async () => {
      const owner = await tenantSession();

      const answer = await getAnswer(owner, "not-a-uuid");

      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.text)).toEqual({ error: { code: "validation_failed", details: { field: "id" } } });
    });

    it("answers 401 without a session", async () => {
      const owner = await tenantSession();
      const project = await createProject(owner, "Weekly review");

      expect((await getAnswer(null, project)).status).toBe(401);
    });
  });
});
