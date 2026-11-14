import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  LocalFsBlobStorageWriter,
  coreAgentRunAction,
  createActionRegistry,
  createAgentRun,
  createChainedAgentRun,
  createChokePoint,
  createHeartbeat,
  createHeartbeatFireAgentTask,
  createPendingApprovalRequest,
  createUser,
  createViewTypeRegistry,
  finishAgentRun,
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  login,
  retryHeartbeatFireJobKey,
  seedSystem,
  setHeartbeatEnabled,
  updateHeartbeatRule,
  withTransaction,
  type AgentRunRow,
  type RunAgentFn,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "agent-run-retry-password";

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

type OccurrenceStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface RunOptions {
  /** The status of the occurrence the run belongs to. Defaults to `failed`. */
  occurrence?: OccurrenceStatus | null;
  attempt?: number;
  triggeredBy?: "heartbeat" | "user";
  /** Whether the run row names its heartbeat. Defaults to `true`. */
  withHeartbeat?: boolean;
  /** How the run is closed: `error` (the default) or `done`; `running` leaves it open. */
  close?: "error" | "done" | "running";
}

interface HeartbeatRun {
  session: Session;
  heartbeatId: string;
  projectItemId: string;
  occurrenceId: string | null;
  run: AgentRunRow;
}

/**
 * A heartbeat of a project of the tenant, an occurrence of it with the given status (none when `occurrence` is
 * `null`) and one run of that occurrence, closed as the options say.
 */
async function heartbeatRun(session: Session, options: RunOptions = {}): Promise<HeartbeatRun> {
  return runInTenant(session.tenant, async () => {
    const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
    if (!projects) throw new Error("The Projects database is missing");
    const project = await createChokePoint(pool).createItem({
      databaseId: projects.id,
      properties: { name: "Weekly review" },
    });
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: project.id,
        name: "Sunday planning",
        rule: { kind: "interval", minutes: 5 },
        actionId: CORE_AGENT_RUN_ACTION_ID,
        actionConfig: { task: "Plan the week" },
      }),
    );
    let occurrenceId: string | null = null;
    if (options.occurrence !== null) {
      // Raw SQL: only the sweep inserts an occurrence, and it does so for a due rule at a time the test cannot set.
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO heartbeat_occurrences (heartbeat_id, scheduled_for, rule_snapshot, status)
         VALUES ($1, now(), $2::jsonb, $3) RETURNING id`,
        [heartbeat.id, JSON.stringify({ kind: "interval", minutes: 5 }), options.occurrence ?? "failed"],
      );
      occurrenceId = rows[0]!.id;
    }
    const run = await createAgentRun(pool, {
      userId: session.userId,
      projectItemId: project.id,
      heartbeatId: options.withHeartbeat === false ? null : heartbeat.id,
      heartbeatOccurrenceId: occurrenceId,
      attempt: options.attempt ?? 1,
      triggeredBy: options.triggeredBy ?? "heartbeat",
      task: "Plan the week",
    });
    const close = options.close ?? "error";
    if (close === "error") await finishAgentRun(pool, run.id, "error", "internal");
    if (close === "done") await finishAgentRun(pool, run.id, "done", "finished");
    return { session, heartbeatId: heartbeat.id, projectItemId: project.id, occurrenceId, run };
  });
}

async function post(session: Session, runId: string, path = "retry"): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/agent-runs/${runId}/${path}`, { method: "POST", headers: session.headers });
  return { status: res.status, body: await res.json() };
}

async function readDetail(session: Session, runId: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api/agent-runs/${runId}`, { headers: session.headers });
  return { status: res.status, body: await res.json() };
}

interface QueuedJob {
  task: string;
  queueName: string | null;
  maxAttempts: number;
  payload: unknown;
}

/**
 * The jobs queued under a key with the task and queue they run on and their payload, read from graphile-worker
 * 0.17.3's private tables: the public `jobs` view has neither the payload nor the queue name.
 */
async function jobsByKey(key: string): Promise<QueuedJob[]> {
  const { rows } = await admin.query<{
    identifier: string;
    queue_name: string | null;
    max_attempts: number;
    payload: unknown;
  }>(
    `SELECT t.identifier, jq.queue_name, j.max_attempts, j.payload
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     LEFT JOIN graphile_worker._private_job_queues jq ON jq.id = j.job_queue_id
     WHERE j.key = $1
     ORDER BY j.id`,
    [key],
  );
  return rows.map((row) => ({
    task: row.identifier,
    queueName: row.queue_name,
    maxAttempts: row.max_attempts,
    payload: row.payload,
  }));
}

/** The job's own payload inside graphile-worker's `{ traceId, payload }` envelope (issue #167), as the task receives it. */
function innerPayloadOf(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null || !("payload" in envelope)) {
    throw new Error("queued job has no envelope");
  }
  return envelope.payload;
}

const jobAnswerSchema = z.object({ jobKey: z.string() });
const errorAnswerSchema = z.object({ code: z.string() });
const retriedBySchema = z.object({ retriedByRunId: z.string().nullable() });

/** The runs that retry `runId` (at most one, by the unique key), read with the superuser pool. */
async function successorsOf(runId: string): Promise<{ id: string; attempt: number; task: string; status: string }[]> {
  const { rows } = await admin.query<{ id: string; attempt: number; task: string; status: string }>(
    "SELECT id, attempt, task, status FROM agent_runs WHERE retry_of_run_id = $1",
    [runId],
  );
  return rows;
}

/** Runs the retry job queued for `runId` through the real fire task, the way the agents worker does, with one attempt. */
async function runRetryJob(fixture: HeartbeatRun, runAgent: RunAgentFn): Promise<void> {
  const [job] = await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id));
  if (!job) throw new Error("no retry job is queued for the run");
  const registry = createActionRegistry();
  registry.set(CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction(pool, runAgent));
  const task = createHeartbeatFireAgentTask(pool, registry);
  const helpers = { job: { id: randomUUID(), attempts: 1, max_attempts: job.maxAttempts } } as Parameters<
    typeof task
  >[1];
  await runInTenant(fixture.session.tenant, () => task(innerPayloadOf(job.payload), helpers));
}

describe("POST /api/agent-runs/:id/retry (issue #1908)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-agent-run-retry-${randomUUID()}`)),
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

  describe("a failed run of a terminal occurrence", () => {
    it.each<OccurrenceStatus>(["failed", "succeeded"])(
      "answers 202 with the job key for an occurrence that %s",
      async (occurrence) => {
        const fixture = await heartbeatRun(await tenantSession(), { occurrence });

        const answer = await post(fixture.session, fixture.run.id);

        expect(answer.status).toBe(202);
        expect(jobAnswerSchema.parse(answer.body)).toEqual({ jobKey: `heartbeat-fire:retry:${fixture.run.id}` });
        expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toHaveLength(1);
      },
    );

    it("queues exactly one job for two concurrent requests, and the worker makes exactly one run of the next attempt", async () => {
      const fixture = await heartbeatRun(await tenantSession(), { attempt: 2 });
      const key = retryHeartbeatFireJobKey(fixture.run.id);

      const answers = await Promise.all([post(fixture.session, fixture.run.id), post(fixture.session, fixture.run.id)]);

      expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
      const jobs = await jobsByKey(key);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        task: "heartbeatFireAgent",
        queueName: `agent-run:${fixture.session.tenant}`,
        maxAttempts: 1,
      });
      expect(innerPayloadOf(jobs[0]!.payload)).toEqual({
        heartbeatId: fixture.heartbeatId,
        retryOfRunId: fixture.run.id,
      });
      // The endpoint writes no run row: the worker creates it per job attempt.
      expect(await successorsOf(fixture.run.id)).toEqual([]);

      const tasks: string[] = [];
      await runRetryJob(fixture, async (input) => {
        tasks.push(input.task);
        return { result: "recovered" };
      });

      const successors = await successorsOf(fixture.run.id);
      expect(successors).toEqual([{ id: expect.any(String), attempt: 3, task: "Plan the week", status: "done" }]);
      const { rows } = await admin.query<{
        retry_of_run_id: string;
        heartbeat_id: string;
        project_item_id: string;
        heartbeat_occurrence_id: string;
      }>(
        "SELECT retry_of_run_id, heartbeat_id, project_item_id, heartbeat_occurrence_id FROM agent_runs WHERE id = $1",
        [successors[0]!.id],
      );
      expect(rows).toEqual([
        {
          retry_of_run_id: fixture.run.id,
          heartbeat_id: fixture.heartbeatId,
          project_item_id: fixture.projectItemId,
          heartbeat_occurrence_id: fixture.occurrenceId,
        },
      ]);
      expect(tasks).toEqual(["Plan the week"]);
    });

    it("shows the retry's id as retriedByRunId on the original run once the worker made it, and null before", async () => {
      const fixture = await heartbeatRun(await tenantSession());

      const before = await readDetail(fixture.session, fixture.run.id);
      await post(fixture.session, fixture.run.id);
      const queued = await readDetail(fixture.session, fixture.run.id);
      await runRetryJob(fixture, async () => undefined);
      const after = await readDetail(fixture.session, fixture.run.id);

      const [successor] = await successorsOf(fixture.run.id);
      expect(before.status).toBe(200);
      expect(retriedBySchema.parse(before.body).retriedByRunId).toBeNull();
      expect(retriedBySchema.parse(queued.body).retriedByRunId).toBeNull();
      expect(retriedBySchema.parse(after.body).retriedByRunId).toBe(successor!.id);
    });

    it("answers 409 not_retryable to a second request once the worker made the retry", async () => {
      const fixture = await heartbeatRun(await tenantSession());
      await post(fixture.session, fixture.run.id);
      await runRetryJob(fixture, async () => undefined);

      const answer = await post(fixture.session, fixture.run.id);

      expect(answer.status).toBe(409);
      expect(errorAnswerSchema.parse(answer.body).code).toBe("not_retryable");
    });

    it("runs a failing retry as a final failure with one notification on the retry's run, and lets that run be retried again", async () => {
      const fixture = await heartbeatRun(await tenantSession());
      await post(fixture.session, fixture.run.id);

      await expect(
        runRetryJob(fixture, async () => {
          throw new Error("model failed again");
        }),
      ).rejects.toThrow("model failed again");

      const [retry] = await successorsOf(fixture.run.id);
      expect(retry).toMatchObject({ attempt: 2, status: "error" });
      const notifications = await admin.query<{ source_id: string }>(
        "SELECT source_id FROM notifications WHERE kind = 'agent_run_error' AND tenant_id = $1",
        [fixture.session.tenant],
      );
      expect(notifications.rows).toEqual([{ source_id: retry!.id }]);
      const again = await post(fixture.session, retry!.id);
      expect(again.status).toBe(202);
      expect(jobAnswerSchema.parse(again.body).jobKey).toBe(retryHeartbeatFireJobKey(retry!.id));
      expect(await jobsByKey(retryHeartbeatFireJobKey(retry!.id))).toHaveLength(1);
    });
  });

  describe("an automatic attempt that may still run", () => {
    it.each<OccurrenceStatus>(["queued", "running"])(
      "answers 409 retry_pending for an occurrence that is %s and queues nothing",
      async (occurrence) => {
        const fixture = await heartbeatRun(await tenantSession(), { occurrence });

        const answer = await post(fixture.session, fixture.run.id);

        expect(answer.status).toBe(409);
        expect(errorAnswerSchema.parse(answer.body).code).toBe("retry_pending");
        expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toEqual([]);
      },
    );
  });

  describe("a run that can never be retried", () => {
    const cases: [string, (session: Session) => Promise<HeartbeatRun>][] = [
      ["a run that succeeded", (session) => heartbeatRun(session, { close: "done" })],
      ["a run that is still running", (session) => heartbeatRun(session, { close: "running" })],
      ["a run triggered by a person", (session) => heartbeatRun(session, { triggeredBy: "user" })],
      [
        "a run of no occurrence, as a manual fire or an item event starts it",
        (session) => heartbeatRun(session, { occurrence: null }),
      ],
      ["a run of a cancelled occurrence", (session) => heartbeatRun(session, { occurrence: "cancelled" })],
      ["a run that names no heartbeat", (session) => heartbeatRun(session, { withHeartbeat: false })],
      [
        "a run that waits for an approval",
        async (session) => {
          const fixture = await heartbeatRun(session, { close: "done" });
          await runInTenant(session.tenant, () =>
            createPendingApprovalRequest(pool, {
              agentRunId: fixture.run.id,
              toolName: "probe",
              riskClass: "unclassified",
              payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
              resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
            }),
          );
          return fixture;
        },
      ],
      [
        "a run that has a successor already",
        async (session) => {
          const fixture = await heartbeatRun(session);
          await runInTenant(session.tenant, () =>
            createChainedAgentRun(pool, {
              retryOfRunId: fixture.run.id,
              attempt: 2,
              projectItemId: fixture.projectItemId,
              heartbeatId: fixture.heartbeatId,
              heartbeatOccurrenceId: fixture.occurrenceId,
              triggeredBy: "heartbeat",
              task: "Plan the week",
            }),
          );
          return fixture;
        },
      ],
    ];

    it.each(cases)("answers 409 not_retryable for %s and queues nothing", async (_label, build) => {
      const fixture = await build(await tenantSession());

      const answer = await post(fixture.session, fixture.run.id);

      expect(answer.status).toBe(409);
      expect(errorAnswerSchema.parse(answer.body).code).toBe("not_retryable");
      expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toEqual([]);
    });
  });

  describe("the refusals of the manual trigger", () => {
    it("answers 409 heartbeat_disabled for a disabled heartbeat and queues nothing", async () => {
      const fixture = await heartbeatRun(await tenantSession());
      await runInTenant(fixture.session.tenant, () =>
        withTransaction(pool, (client) => setHeartbeatEnabled(client, fixture.heartbeatId, false)),
      );

      const answer = await post(fixture.session, fixture.run.id);

      expect(answer.status).toBe(409);
      expect(errorAnswerSchema.parse(answer.body).code).toBe("heartbeat_disabled");
      expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toEqual([]);
    });

    it("answers 409 heartbeat_event_triggered for a heartbeat whose rule is event-triggered and queues nothing", async () => {
      const fixture = await heartbeatRun(await tenantSession());
      await runInTenant(fixture.session.tenant, async () => {
        const projects = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
        if (!projects) throw new Error("The Projects database is missing");
        await withTransaction(pool, (client) =>
          updateHeartbeatRule(client, fixture.heartbeatId, {
            kind: "onItemEvent",
            databaseId: projects.id,
            event: "create",
          }),
        );
      });

      const answer = await post(fixture.session, fixture.run.id);

      expect(answer.status).toBe(409);
      expect(errorAnswerSchema.parse(answer.body).code).toBe("heartbeat_event_triggered");
      expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toEqual([]);
    });
  });

  describe("the request", () => {
    it("answers 404 for an unknown run id and queues nothing", async () => {
      const session = await tenantSession();
      const unknown = randomUUID();

      const answer = await post(session, unknown);

      expect(answer).toEqual({ status: 404, body: { error: "Not found" } });
      expect(await jobsByKey(retryHeartbeatFireJobKey(unknown))).toEqual([]);
    });

    it("answers 400 validation_failed naming 'id' for an id that is not a UUID", async () => {
      const session = await tenantSession();

      const answer = await post(session, "not-a-uuid");

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: "validation_failed", details: { field: "id" } });
    });

    it("answers 404 to a GET of the retry path, which is no read", async () => {
      const fixture = await heartbeatRun(await tenantSession());

      const res = await fetch(`${baseUrl}/api/agent-runs/${fixture.run.id}/retry`, {
        headers: fixture.session.headers,
      });

      expect(res.status).toBe(404);
      expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toEqual([]);
    });

    it("answers 401 without a session and queues nothing", async () => {
      const fixture = await heartbeatRun(await tenantSession());

      const res = await fetch(`${baseUrl}/api/agent-runs/${fixture.run.id}/retry`, { method: "POST" });

      expect(res.status).toBe(401);
      expect(await jobsByKey(retryHeartbeatFireJobKey(fixture.run.id))).toEqual([]);
    });

    it("answers a run of another tenant exactly as an unknown id and queues nothing", async () => {
      const owner = await heartbeatRun(await tenantSession());
      const stranger = await tenantSession();

      const foreign = await post(stranger, owner.run.id);
      const unknown = await post(stranger, randomUUID());

      expect(foreign).toEqual({ status: 404, body: { error: "Not found" } });
      expect(unknown).toEqual(foreign);
      expect(await jobsByKey(retryHeartbeatFireJobKey(owner.run.id))).toEqual([]);
      // The owner's own request for the same run is accepted, so the 404 above is the tenant, not the run.
      expect((await post(owner.session, owner.run.id)).status).toBe(202);
    });
  });
});
