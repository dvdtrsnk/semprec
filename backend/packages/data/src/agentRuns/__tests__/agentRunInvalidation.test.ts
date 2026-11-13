import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook } from "../../realtimeHook.js";
import { publishAgentRunInvalidation } from "../agentRunInvalidation.js";
import {
  createAgentRun,
  createChainedAgentRun,
  finishAgentRun,
  finishAgentRunWithErrorNotification,
} from "../agentRunsStore.js";

interface AgentRunsAnnouncement {
  projectItemId: string | null;
  agentRunId: string;
  userId: string | undefined;
}

let pool: Pool;
let announcements: AgentRunsAnnouncement[];
let tenantZeroUserId: string;

describe("agentRuns invalidations (issue #1863)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenantZeroUserId = (await createTenantZeroUser(pool)).id;
    announcements = [];
    setInvalidationHook((event) => {
      if (event.scope === "agentRuns")
        announcements.push({ projectItemId: event.projectItemId, agentRunId: event.agentRunId, userId: event.userId });
    });
  });
  afterEach(() => {
    setInvalidationHook(() => {});
  });

  it("announces a created run to its actor with its project, only once the transaction committed", async () => {
    const projectItemId = await inTenantZero(() => createTestProjectItem(pool));

    const run = await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const created = await createAgentRun(client, { triggeredBy: "user", task: "announce", projectItemId });
        expect(announcements).toEqual([]);
        return created;
      }),
    );

    expect(announcements).toEqual([{ projectItemId, agentRunId: run.id, userId: tenantZeroUserId }]);
  });

  it("announces a run without a project with a null project id", async () => {
    const run = await inTenantZero(() =>
      withTransaction(pool, (client) => createAgentRun(client, { triggeredBy: "user", task: "no project" })),
    );

    expect(announcements).toEqual([{ projectItemId: null, agentRunId: run.id, userId: tenantZeroUserId }]);
  });

  it("announces a run created on a bare pool right after the statement", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "autocommit" });

    expect(announcements).toEqual([{ projectItemId: null, agentRunId: run.id, userId: tenantZeroUserId }]);
  });

  it("announces nothing when the transaction that created the run rolls back", async () => {
    await expect(
      inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await createAgentRun(client, { triggeredBy: "user", task: "rolled back" });
          throw new Error("force rollback");
        }),
      ),
    ).rejects.toThrow("force rollback");

    expect(announcements).toEqual([]);
  });

  it("announces a retry run created by createChainedAgentRun, and nothing for a retry that lost the race", async () => {
    const first = await createAgentRun(pool, { triggeredBy: "user", task: "first" });
    announcements.length = 0;

    const retry = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createChainedAgentRun(client, { triggeredBy: "user", task: "retry", retryOfRunId: first.id }),
      ),
    );
    expect(retry).not.toBeNull();
    expect(announcements).toEqual([{ projectItemId: null, agentRunId: retry!.id, userId: tenantZeroUserId }]);
    announcements.length = 0;

    const second = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createChainedAgentRun(client, { triggeredBy: "user", task: "retry again", retryOfRunId: first.id }),
      ),
    );
    expect(second).toBeNull();
    expect(announcements).toEqual([]);
  });

  it("announces a run that finished done, and a run that finished as error, to its actor", async () => {
    const projectItemId = await inTenantZero(() => createTestProjectItem(pool));
    const doneRun = await createAgentRun(pool, { triggeredBy: "user", task: "done", projectItemId });
    const errorRun = await createAgentRun(pool, { triggeredBy: "user", task: "error", projectItemId });
    announcements.length = 0;

    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        expect(await finishAgentRun(client, doneRun.id, "done", "all good")).toBe(true);
        expect(announcements).toEqual([]);
      }),
    );
    expect(announcements).toEqual([{ projectItemId, agentRunId: doneRun.id, userId: tenantZeroUserId }]);
    announcements.length = 0;

    await inTenantZero(() =>
      withTransaction(pool, (client) => finishAgentRunWithErrorNotification(client, errorRun.id, "interrupted")),
    );
    expect(announcements).toEqual([{ projectItemId, agentRunId: errorRun.id, userId: tenantZeroUserId }]);
  });

  it("announces a close made on a bare pool, including the error close that opens its own transaction", async () => {
    const doneRun = await createAgentRun(pool, { triggeredBy: "user", task: "done" });
    const errorRun = await createAgentRun(pool, { triggeredBy: "user", task: "error" });
    announcements.length = 0;

    await inTenantZero(() => finishAgentRun(pool, doneRun.id, "done", null));
    await inTenantZero(() => finishAgentRunWithErrorNotification(pool, errorRun.id, "interrupted"));

    expect(announcements).toEqual([
      { projectItemId: null, agentRunId: doneRun.id, userId: tenantZeroUserId },
      { projectItemId: null, agentRunId: errorRun.id, userId: tenantZeroUserId },
    ]);
  });

  it("announces nothing for a close that lost to another closer, or for a run that does not exist", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "closed twice" });
    await inTenantZero(() => finishAgentRun(pool, run.id, "done", null));
    announcements.length = 0;

    expect(await inTenantZero(() => finishAgentRun(pool, run.id, "done", null))).toBe(false);
    await expect(inTenantZero(() => finishAgentRun(pool, randomUUID(), "done", null))).rejects.toThrow("not found");

    expect(announcements).toEqual([]);
  });

  it("announces nothing when the transaction that closed the run rolls back", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "close rolled back" });
    announcements.length = 0;

    await expect(
      inTenantZero(() =>
        withTransaction(pool, async (client) => {
          await finishAgentRun(client, run.id, "done", null);
          throw new Error("force rollback");
        }),
      ),
    ).rejects.toThrow("force rollback");

    expect(announcements).toEqual([]);
  });

  it("publishes nothing for an unknown run id, on a transaction client or a bare pool", async () => {
    await inTenantZero(() => withTransaction(pool, (client) => publishAgentRunInvalidation(client, randomUUID())));
    await inTenantZero(() => publishAgentRunInvalidation(pool, randomUUID()));

    expect(announcements).toEqual([]);
  });

  it("does not see another tenant's run through the runtime role, and announces the caller's own run to its own user", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const userB = await createUser(pool, {
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      tenantId: tenantB,
    });
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const runOfA = await withTenantTransaction(runtime, tenantA, (client) =>
        createAgentRun(client, { triggeredBy: "user", task: "of A" }),
      );
      const runOfB = await withTenantTransaction(runtime, tenantB, (client) =>
        createAgentRun(client, { triggeredBy: "user", task: "of B" }),
      );
      expect(announcements.map((entry) => entry.agentRunId)).toEqual([runOfA.id, runOfB.id]);
      announcements.length = 0;

      // Tenant B's scope shows no run of tenant A: the id is as good as unknown and nothing is sent.
      await withTenantTransaction(runtime, tenantB, (client) => publishAgentRunInvalidation(client, runOfA.id));
      expect(announcements).toEqual([]);

      await withTenantTransaction(runtime, tenantB, (client) => publishAgentRunInvalidation(client, runOfB.id));
      expect(announcements).toEqual([{ projectItemId: null, agentRunId: runOfB.id, userId: userB.id }]);
    } finally {
      await runtime.end();
    }
  });
});
