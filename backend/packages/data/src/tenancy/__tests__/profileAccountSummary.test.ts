import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { hashPassword } from "../../auth/passwordHash.js";
import { provisionTenant } from "../provisionTenant.js";
import { getProfileAccountSummary } from "../profileAccountSummary.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "../../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenantId: string;
let userId: string;

/**
 * `pool` with a `connect` and a `query` that count their calls together and refuse the `failAt`th one (1-based; 0
 * refuses none). Every read of the summary reaches the database through one of the two, so each can be refused.
 */
function poolRefusingCall(pool: Pool, failAt: number): { pool: Pool; calls: () => number } {
  let calls = 0;
  const refuse = (): boolean => {
    calls += 1;
    return calls === failAt;
  };
  const refusing = new Proxy(pool, {
    get(target, key, receiver) {
      if (key === "connect") {
        return async (): Promise<PoolClient> => {
          if (refuse()) throw new Error("call refused by the test");
          return target.connect();
        };
      }
      if (key === "query") {
        return (...args: unknown[]): unknown => {
          if (refuse()) return Promise.reject(new Error("call refused by the test"));
          return Reflect.apply(target.query.bind(target), undefined, args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { pool: refusing, calls: () => calls };
}

/** Waits until every connection the pool opened is back, so a read that outlived a failed call cannot touch the next one. */
async function untilIdle(pool: Pool): Promise<void> {
  const deadline = Date.now() + 5000;
  while (pool.totalCount !== pool.idleCount) {
    if (Date.now() > deadline) throw new Error("the pool still has connections in use");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenantId = await createTestTenant(admin);
  await provisionTenant(runtime, tenantId);
  await setTenantAiBudget(admin, tenantId);
  const user = await runAsSystem("profile account summary test user", async () =>
    createUser(admin, {
      email: `${tenantId}@example.test`,
      passwordHash: await hashPassword("pw-test-1234"),
      tenantId,
    }),
  );
  userId = user.id;
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
});

describe("getProfileAccountSummary", () => {
  it("answers zeros for a provisioned tenant that has no data yet", async () => {
    const summary = await runInTenant(tenantId, () => getProfileAccountSummary(runtime, { userId }));

    expect(summary).toEqual({
      activeSessions: 0,
      mailAccountCount: 0,
      mailAccountsNeedingReauth: [],
      trashItems: 0,
      trashDatabases: 0,
      problemCount: 0,
      aiCostMonthUsd: 0,
    });
  });

  it("refuses to run without a tenant scope instead of answering for no tenant", async () => {
    await expect(getProfileAccountSummary(runtime, { userId })).rejects.toThrow(
      "getProfileAccountSummary requires an active tenant scope",
    );
  });

  it("refuses to run in the system scope, which is not a tenant", async () => {
    await expect(
      runAsSystem("profile account summary test", () => getProfileAccountSummary(runtime, { userId })),
    ).rejects.toThrow("getProfileAccountSummary requires an active tenant scope");
  });

  it("fails as a whole when any one of its reads fails, whichever it is, and returns no partial summary", async () => {
    const counted = poolRefusingCall(runtime, 0);
    await runInTenant(tenantId, () => getProfileAccountSummary(counted.pool, { userId }));
    const calls = counted.calls();
    // Five owners read, and each reaches the database at least once.
    expect(calls).toBeGreaterThanOrEqual(5);

    for (let failAt = 1; failAt <= calls; failAt += 1) {
      const refusing = poolRefusingCall(runtime, failAt);
      await expect(
        runInTenant(tenantId, () => getProfileAccountSummary(refusing.pool, { userId })),
        `the summary survived the refusal of call ${failAt}`,
      ).rejects.toThrow("call refused by the test");
      await untilIdle(runtime);
    }
  });
});
