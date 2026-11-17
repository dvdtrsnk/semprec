import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import {
  createAgentRun,
  createChainedAgentRun,
  finishAgentRun,
  getAgentRun,
  getRetrySuccessorId,
  setAgentRunMcpClientName,
} from "../agentRuns/agentRunsStore.js";
import { NotFoundError } from "../errors.js";
import { withTransaction } from "../db/pool.js";

let pool: Pool;

function checkErrorCodeSignature(client: Pool): void {
  // @ts-expect-error An error close requires a structured error code.
  void finishAgentRun(client, "run", "error", "failed");
}
void checkErrorCodeSignature;

describe("finishAgentRun", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createTenantZeroUser(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("closes a running run and returns true", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    await expect(finishAgentRun(pool, run.id, "done", "result text")).resolves.toBe(true);

    const finished = await getAgentRun(pool, run.id);
    expect(finished).toMatchObject({ status: "done", result: "result text" });
    expect(finished!.finishedAt).not.toBeNull();
  });

  it.each([
    ["done", "error", "first"],
    ["error", "done", "modelError"],
  ] as const)(
    "keeps the first close (%s) when a second one (%s) arrives and returns false",
    async (first, second, firstResult) => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });
      // A `done` close stores its snapshot; an `error` close stores its code, which is also its result.
      const close = (status: "done" | "error", position: "first" | "second") =>
        status === "done"
          ? finishAgentRun(pool, run.id, "done", position)
          : finishAgentRun(pool, run.id, "error", position === "first" ? "modelError" : "internal");
      await expect(close(first, "first")).resolves.toBe(true);
      const afterFirst = await getAgentRun(pool, run.id);

      await expect(close(second, "second")).resolves.toBe(false);

      const afterSecond = await getAgentRun(pool, run.id);
      expect(afterSecond).toMatchObject({ status: first, result: firstResult, finishedAt: afterFirst!.finishedAt });
    },
  );

  it("stores the canonical code as the result of an error close, and the snapshot as the result of a done close", async () => {
    const failed = await createAgentRun(pool, { triggeredBy: "user", task: "fails" });
    const succeeded = await createAgentRun(pool, { triggeredBy: "user", task: "works" });

    await finishAgentRun(pool, failed.id, "error", "modelError");
    await finishAgentRun(pool, succeeded.id, "done", "snapshot text");

    expect(await getAgentRun(pool, failed.id)).toMatchObject({
      status: "error",
      errorCode: "modelError",
      result: "modelError",
    });
    expect(await getAgentRun(pool, succeeded.id)).toMatchObject({
      status: "done",
      errorCode: null,
      result: "snapshot text",
    });
  });

  it("refuses an error close with a value outside the code set and leaves the run running", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "fails" });

    // @ts-expect-error The overload takes a code; this is a caller that bypasses the types.
    await expect(finishAgentRun(pool, run.id, "error", "free text")).rejects.toThrow("Unknown error code");

    expect(await getAgentRun(pool, run.id)).toMatchObject({ status: "running", result: null, errorCode: null });
  });

  it("stores the error code and detail in the same update as the status, and reads null for a done run", async () => {
    const failed = await createAgentRun(pool, { triggeredBy: "user", task: "fails" });
    await finishAgentRun(pool, failed.id, "error", "modelError", { attempt: 2 });
    expect(await getAgentRun(pool, failed.id)).toMatchObject({
      status: "error",
      errorCode: "modelError",
      errorDetail: { attempt: 2 },
    });

    const done = await createAgentRun(pool, { triggeredBy: "user", task: "works" });
    await finishAgentRun(pool, done.id, "done", "ok");
    expect(await getAgentRun(pool, done.id)).toMatchObject({ errorCode: null, errorDetail: null });
  });

  it("reads a row closed as error without a code (previous release) as internal", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "legacy" });
    await pool.query(`UPDATE agent_runs SET status = 'error', result = 'old' WHERE id = $1`, [run.id]);
    expect(await getAgentRun(pool, run.id)).toMatchObject({ errorCode: "internal", errorDetail: null });
  });

  it("rejects a code outside the closed set at the database", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "bad" });
    await expect(pool.query(`UPDATE agent_runs SET error_code = 'nope' WHERE id = $1`, [run.id])).rejects.toThrow();
  });

  it("rejects a non-object error detail read from the database", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "bad detail" });
    for (const value of [[], "text", 12, true]) {
      await pool.query("UPDATE agent_runs SET error_detail = $2::jsonb WHERE id = $1", [run.id, JSON.stringify(value)]);
      await expect(getAgentRun(pool, run.id)).rejects.toThrow(/error_detail/);
    }
  });

  it("throws NotFoundError for an unknown run id", async () => {
    await expect(finishAgentRun(pool, randomUUID(), "done", null)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("createAgentRun actor in a tenant (issue #1018)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantB: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(adminPool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(adminPool));
    tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(adminPool));
    userA = (
      await runInTenant(getTenantZeroId(), () =>
        createUser(adminPool, { email: "a@example.test", passwordHash: "x", tenantId: getTenantZeroId() }),
      )
    ).id;
    userB = (
      await runInTenant(tenantB, () =>
        createUser(adminPool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
      )
    ).id;
  });

  afterAll(async () => {
    await Promise.all([runtimePool?.end(), adminPool?.end()]);
  });

  it("attributes a root run without userId to the tenant's user, never to the earlier-created account", async () => {
    const run = await runInTenant(tenantB, () => createAgentRun(runtimePool, { triggeredBy: "heartbeat", task: "t" }));
    expect(run.actorUserId).toBe(userB);
    expect(run.actorUserId).not.toBe(userA);
  });

  it("throws when the tenant has no bound user", async () => {
    const tenantC = await runInTenant(getTenantZeroId(), () => createTestTenant(adminPool));
    await expect(
      runInTenant(tenantC, () => createAgentRun(runtimePool, { triggeredBy: "heartbeat", task: "t" })),
    ).rejects.toThrow("Cannot create an agent run: the current tenant has no user");
  });

  it("uses an explicit userId, and a delegated run still inherits its parent's actor", async () => {
    const explicit = await runInTenant(tenantB, () =>
      createAgentRun(runtimePool, { triggeredBy: "user", task: "t", userId: userB }),
    );
    expect(explicit.actorUserId).toBe(userB);

    const child = await runInTenant(tenantB, () =>
      createAgentRun(runtimePool, { triggeredBy: "user", task: "child", parentRunId: explicit.id, userId: userA }),
    );
    expect(child.actorUserId).toBe(userB);
  });
});

describe("agent run retry chain (issue #1448)", () => {
  let chainPool: Pool;

  beforeEach(async () => {
    chainPool ??= getTestPool();
    await resetDatabase(chainPool);
    await createTenantZeroUser(chainPool);
  });

  afterAll(async () => {
    await chainPool?.end();
  });

  it("creates an unlinked run as attempt 1 with no retry link", async () => {
    const run = await createAgentRun(chainPool, { triggeredBy: "user", task: "t" });
    expect(run).toMatchObject({ attempt: 1, retryOfRunId: null });
  });

  it("inserts a chained run with the given attempt and the retried run's actor, once", async () => {
    const first = await createAgentRun(chainPool, { triggeredBy: "user", task: "t" });

    const retry = await createChainedAgentRun(chainPool, {
      triggeredBy: "user",
      task: "t",
      retryOfRunId: first.id,
      attempt: 2,
    });
    expect(retry).toMatchObject({ retryOfRunId: first.id, attempt: 2, actorUserId: first.actorUserId });

    await expect(
      createChainedAgentRun(chainPool, { triggeredBy: "user", task: "t", retryOfRunId: first.id, attempt: 2 }),
    ).resolves.toBeNull();
    const { rows } = await chainPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agent_runs WHERE retry_of_run_id = $1",
      [first.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("creates exactly one row for two concurrent chained runs of the same run", async () => {
    const first = await createAgentRun(chainPool, { triggeredBy: "user", task: "t" });
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("Missing test database URL");
    const owned = new Pool({
      connectionString: url,
      max: 3,
      connectionTimeoutMillis: 3000,
      statement_timeout: 4000,
      query_timeout: 5000,
    });
    let release: () => void = () => {};
    let reportHolder: (pid: number) => void = () => {};
    let reportContender: (pid: number) => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holderStarted = new Promise<number>((resolve) => {
      reportHolder = resolve;
    });
    const contenderStarted = new Promise<number>((resolve) => {
      reportContender = resolve;
    });
    const input = { triggeredBy: "user" as const, task: "t", retryOfRunId: first.id, attempt: 2 };
    const holder = runInTenant(getTenantZeroId(), () =>
      withTransaction(owned, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing holder PID");
        const inserted = await createChainedAgentRun(client, input);
        if (!inserted) throw new Error("First retry was not inserted");
        reportHolder(pid);
        await gate;
        return inserted;
      }),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let contender:
      Promise<{ value: Awaited<ReturnType<typeof createChainedAgentRun>> } | { error: unknown }> | undefined;
    let failure: { error: unknown } | undefined;
    let holderFailureObserved = false;
    let contenderFailureObserved = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const bounded = <T>(signal: Promise<T>): Promise<T> =>
      Promise.race([
        signal,
        new Promise<never>((_, reject) => {
          timers.push(setTimeout(() => reject(new Error("Retry overlap coordination timed out")), 3000));
        }),
      ]);
    try {
      const holderRace = await bounded(
        Promise.race([
          holderStarted.then((pid) => ({ kind: "started" as const, pid })),
          holder.then((outcome) => ({ kind: "settled" as const, outcome })),
        ]),
      );
      if (holderRace.kind === "settled") {
        if ("error" in holderRace.outcome) {
          holderFailureObserved = true;
          throw holderRace.outcome.error;
        }
        throw new Error("Holder ended before overlap");
      }
      const holderPid = holderRace.pid;
      contender = runInTenant(getTenantZeroId(), () =>
        withTransaction(owned, async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing contender PID");
          reportContender(pid);
          return createChainedAgentRun(client, input);
        }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const contenderRace = await bounded(
        Promise.race([
          contenderStarted.then((pid) => ({ kind: "started" as const, pid })),
          contender.then((outcome) => ({ kind: "settled" as const, outcome })),
        ]),
      );
      if (contenderRace.kind === "settled") {
        if ("error" in contenderRace.outcome) {
          contenderFailureObserved = true;
          throw contenderRace.outcome.error;
        }
        throw new Error("Contender ended before overlap");
      }
      const contenderPid = contenderRace.pid;
      const deadline = Date.now() + 2500;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const observed = await owned.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [holderPid, contenderPid],
        );
        blocked = observed.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } catch (error) {
      failure = { error };
    }
    for (const timer of timers) clearTimeout(timer);
    release();
    const outcomes = await Promise.all([holder, ...(contender ? [contender] : [])]);
    const errors: unknown[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if ("error" in outcome && !(index === 0 ? holderFailureObserved : contenderFailureObserved))
        errors.push(outcome.error);
    }
    try {
      await owned.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Retry overlap failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    expect(outcomes).toHaveLength(2);
    const second = outcomes[1];
    if (!second || "error" in second) throw new Error("Missing contender outcome");
    expect(second.value).toBeNull();
    const { rows } = await chainPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agent_runs WHERE retry_of_run_id = $1",
      [first.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("throws NotFoundError for a chained run of a run that does not exist", async () => {
    await expect(
      createChainedAgentRun(chainPool, { triggeredBy: "user", task: "t", retryOfRunId: randomUUID(), attempt: 2 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns the successor id from getRetrySuccessorId, or null for a run that was not retried", async () => {
    const first = await createAgentRun(chainPool, { triggeredBy: "user", task: "t" });
    await expect(getRetrySuccessorId(chainPool, first.id)).resolves.toBeNull();
    const retry = await createChainedAgentRun(chainPool, {
      triggeredBy: "user",
      task: "t",
      retryOfRunId: first.id,
      attempt: 2,
    });
    await expect(getRetrySuccessorId(chainPool, first.id)).resolves.toBe(retry!.id);
  });
});

describe("setAgentRunMcpClientName (issue #1788)", () => {
  let namePool: Pool;

  beforeEach(async () => {
    namePool ??= getTestPool();
    await resetDatabase(namePool);
    await createTenantZeroUser(namePool);
  });

  afterAll(async () => {
    await namePool?.end();
  });

  async function createMcpRun(): Promise<string> {
    return (await createAgentRun(namePool, { triggeredBy: "mcp", task: "t" })).id;
  }

  async function storedName(runId: string): Promise<string | null> {
    const run = await getAgentRun(namePool, runId);
    if (!run) throw new Error("The run is missing");
    return run.mcpClientName;
  }

  it("reads null for a run no client named and the stored name after a write", async () => {
    const runId = await createMcpRun();
    expect(await storedName(runId)).toBeNull();

    await setAgentRunMcpClientName(namePool, runId, "Claude Desktop");

    expect(await storedName(runId)).toBe("Claude Desktop");
  });

  it("replaces a name stored before and leaves another run's name alone", async () => {
    const runId = await createMcpRun();
    const otherRunId = await createMcpRun();
    await setAgentRunMcpClientName(namePool, runId, "Claude Desktop");
    await setAgentRunMcpClientName(namePool, otherRunId, "Other Client");

    await setAgentRunMcpClientName(namePool, runId, "Cursor");

    expect(await storedName(runId)).toBe("Cursor");
    expect(await storedName(otherRunId)).toBe("Other Client");
  });

  it("removes control characters and surrounding whitespace", async () => {
    const runId = await createMcpRun();

    await setAgentRunMcpClientName(namePool, runId, " \tCla\u0000ude\u001b Desk\u007ftop\u0085 \n");

    expect(await storedName(runId)).toBe("Claude Desktop");
  });

  it("keeps a name of 64 characters whole and cuts a longer one to its first 64", async () => {
    const exact = await createMcpRun();
    const longer = await createMcpRun();

    await setAgentRunMcpClientName(namePool, exact, "x".repeat(64));
    await setAgentRunMcpClientName(namePool, longer, `${"x".repeat(64)}yz`);

    expect(await storedName(exact)).toBe("x".repeat(64));
    expect(await storedName(longer)).toBe("x".repeat(64));
  });

  it("counts characters as the column's check does, so 64 characters outside the basic plane fit", async () => {
    const runId = await createMcpRun();

    await setAgentRunMcpClientName(namePool, runId, "\u{1F600}".repeat(70));

    expect(await storedName(runId)).toBe("\u{1F600}".repeat(64));
  });

  it("removes whitespace that the cut leaves at the end", async () => {
    const runId = await createMcpRun();

    await setAgentRunMcpClientName(namePool, runId, `${"a".repeat(63)} ${"b".repeat(10)}`);

    expect(await storedName(runId)).toBe("a".repeat(63));
  });

  it.each([
    ["an empty name", ""],
    ["whitespace", " \u00a0 "],
    ["control characters", "\u0000\u0007\u009f"],
    ["control characters and whitespace", " \t\u0000\n "],
  ])("clears a name stored before for %s", async (_label, name) => {
    const runId = await createMcpRun();
    await setAgentRunMcpClientName(namePool, runId, "Claude Desktop");

    await setAgentRunMcpClientName(namePool, runId, name);

    expect(await storedName(runId)).toBeNull();
  });

  it("throws NotFoundError for an unknown run id and names no run", async () => {
    const runId = await createMcpRun();

    await expect(setAgentRunMcpClientName(namePool, randomUUID(), "Claude Desktop")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(await storedName(runId)).toBeNull();
  });
});

describe("setAgentRunMcpClientName in a tenant (issue #1788)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantA: string;
  let tenantB: string;
  let runA: string;
  let otherRunA: string;
  let runB: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(adminPool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(adminPool));
    tenantA = getTenantZeroId();
    tenantB = await runInTenant(tenantA, () => createTestTenant(adminPool));
    for (const tenantId of [tenantA, tenantB]) {
      await runInTenant(tenantId, () =>
        createUser(adminPool, { email: `${randomUUID()}@example.test`, passwordHash: "x", tenantId }),
      );
    }
    const createRun = (tenantId: string) =>
      runInTenant(tenantId, async () => (await createAgentRun(runtimePool, { triggeredBy: "mcp", task: "t" })).id);
    runA = await createRun(tenantA);
    otherRunA = await createRun(tenantA);
    runB = await createRun(tenantB);
    await runInTenant(tenantB, () => setAgentRunMcpClientName(runtimePool, runB, "Tenant B Client"));
  });

  afterAll(async () => {
    await Promise.all([runtimePool?.end(), adminPool?.end()]);
  });

  async function storedName(tenantId: string, runId: string): Promise<string | null> {
    const run = await runInTenant(tenantId, () => getAgentRun(runtimePool, runId));
    if (!run) throw new Error("The run is missing in its own tenant");
    return run.mcpClientName;
  }

  it("names a run of the current tenant and no other run", async () => {
    await runInTenant(tenantA, () => setAgentRunMcpClientName(runtimePool, runA, "Claude Desktop"));

    expect(await storedName(tenantA, runA)).toBe("Claude Desktop");
    expect(await storedName(tenantA, otherRunA)).toBeNull();
    expect(await storedName(tenantB, runB)).toBe("Tenant B Client");
  });

  it("answers another tenant's run like an unknown run and leaves its name as it was", async () => {
    const foreign = runInTenant(tenantA, () => setAgentRunMcpClientName(runtimePool, runB, "Claude Desktop"));
    await expect(foreign).rejects.toBeInstanceOf(NotFoundError);
    const unknown = runInTenant(tenantA, () => setAgentRunMcpClientName(runtimePool, randomUUID(), "Claude Desktop"));
    await expect(unknown).rejects.toBeInstanceOf(NotFoundError);

    expect(await storedName(tenantB, runB)).toBe("Tenant B Client");
    expect(await storedName(tenantA, runA)).toBeNull();
  });
});
