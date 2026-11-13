import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { raiseProblem, resolveProblem, type RaiseProblemInput } from "../sempProblemsStore.js";

let admin: Pool;
let runtimePool: Pool;
let tenantZero: string;
let userZero: string;
let events: InvalidationEvent[];

function input(overrides: Partial<RaiseProblemInput> = {}): RaiseProblemInput {
  return {
    userId: userZero,
    category: "mail",
    kind: "mailSyncFailed",
    severity: "warning",
    sourceTable: "mail_account_sync_state",
    sourceId: randomUUID(),
    dedupeKey: "mail:sync:account-1",
    occurrenceKey: "job-1",
    ...overrides,
  };
}

/** Runs `fn` as the runtime role in a committed transaction scoped to tenant zero. */
function inZero<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction(runtimePool, tenantZero, fn);
}

describe("sempStatus invalidations (issue #1868)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtimePool = await createRuntimeRolePool(admin, "semprec_data");
    tenantZero = getTenantZeroId();
  });
  afterAll(async () => {
    await runtimePool?.end();
    await admin?.end();
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    userZero = (await createTenantZeroUser(admin)).id;
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "sempStatus") events.push(event);
    });
  });
  afterEach(() => {
    setInvalidationHook(() => {});
  });

  it("announces a raised problem once the transaction committed, with no field but the scope", async () => {
    const outcome = await inZero(async (client) => {
      const raised = await raiseProblem(client, input());
      expect(events).toEqual([]);
      return raised.outcome;
    });

    expect(outcome).toBe("created");
    expect(events).toEqual([{ scope: "sempStatus" }]);
  });

  it("announces a repeated occurrence that merges into the active problem", async () => {
    await inZero((client) => raiseProblem(client, input()));
    events.length = 0;

    const merged = await inZero((client) => raiseProblem(client, input({ occurrenceKey: "job-2" })));

    expect(merged.outcome).toBe("merged");
    expect(events).toEqual([{ scope: "sempStatus" }]);
  });

  it("announces the escalation of a warning to critical, even for an occurrence it already counted", async () => {
    await inZero((client) => raiseProblem(client, input()));
    events.length = 0;

    const escalated = await inZero((client) => raiseProblem(client, input({ severity: "critical" })));

    expect(escalated.outcome).toBe("escalated");
    expect(events).toEqual([{ scope: "sempStatus" }]);
  });

  it("announces nothing for a replay of an occurrence that was already counted", async () => {
    await inZero((client) => raiseProblem(client, input()));
    events.length = 0;

    const replayed = await inZero((client) => raiseProblem(client, input()));

    expect(replayed.outcome).toBe("merged");
    expect(events).toEqual([]);
  });

  it("announces nothing for a replay that cannot raise the severity of a critical problem", async () => {
    await inZero((client) => raiseProblem(client, input({ severity: "critical" })));
    events.length = 0;

    await inZero((client) => raiseProblem(client, input({ severity: "critical" })));
    await inZero((client) => raiseProblem(client, input({ severity: "warning" })));

    expect(events).toEqual([]);
  });

  it("announces nothing when the transaction that raised the problem rolls back", async () => {
    await expect(
      inZero(async (client) => {
        await raiseProblem(client, input());
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    expect(events).toEqual([]);
  });

  it("announces nothing for a raise that is refused for an invalid project", async () => {
    await expect(inZero((client) => raiseProblem(client, input({ projectItemId: randomUUID() })))).rejects.toThrow(
      "Invalid projectItemId",
    );

    expect(events).toEqual([]);
  });

  it("announces a problem that is resolved, and nothing for a second resolve of it or for an unknown key", async () => {
    await inZero((client) => raiseProblem(client, input()));
    events.length = 0;

    expect(
      await inZero((client) =>
        resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "recovered" }),
      ),
    ).toBe(true);
    expect(events).toEqual([{ scope: "sempStatus" }]);
    events.length = 0;

    expect(
      await inZero((client) =>
        resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "recovered" }),
      ),
    ).toBe(false);
    expect(
      await inZero((client) => resolveProblem(client, { dedupeKey: "mail:sync:unknown", resolutionKind: "recovered" })),
    ).toBe(false);
    expect(events).toEqual([]);
  });

  it("announces nothing when the transaction that resolved the problem rolls back", async () => {
    await inZero((client) => raiseProblem(client, input()));
    events.length = 0;

    await expect(
      inZero(async (client) => {
        await resolveProblem(client, { dedupeKey: "mail:sync:account-1", resolutionKind: "recovered" });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    expect(events).toEqual([]);
  });

  it("announces nothing for a resolve with an unknown resolution kind", async () => {
    await inZero((client) => raiseProblem(client, input()));
    events.length = 0;

    await expect(
      inZero((client) =>
        resolveProblem(client, {
          dedupeKey: "mail:sync:account-1",
          resolutionKind: "bogus" as "recovered",
        }),
      ),
    ).rejects.toThrow("Unknown problem resolution kind");

    expect(events).toEqual([]);
  });
});
