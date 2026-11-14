import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope, runInTenant, type TenantScope } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import {
  hashIdempotentRequest,
  readIdempotencyKeyHeader,
  runIdempotent,
  type IdempotentResponse,
} from "../inbox/idempotentResponsesStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { purgeExpiredTrash } from "../trash/purgeExpiredTrash.js";

let admin: Pool;
let runtime: Pool;
let tenantA: string;
let tenantB: string;

const ROUTE = "PATCH /api/proposals/:id/values";
const OTHER_ROUTE = "POST /api/proposals/:id/reset-overrides";
const userA = randomUUID();
const userB = randomUUID();

const inTenantTransaction = <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  runInTenant(tenantId, () => withTransaction(runtime, fn));

interface CallOptions {
  tenantId?: string;
  userId?: string;
  key?: string;
  route?: string;
  requestHash?: string;
}

/** One `runIdempotent` call in its own transaction of `tenantId`, as a route handler makes it. */
function call(action: () => Promise<IdempotentResponse>, options: CallOptions = {}): Promise<IdempotentResponse> {
  return inTenantTransaction(options.tenantId ?? tenantA, (client) =>
    runIdempotent(
      client,
      {
        tenantScope: currentTenantScope(),
        userId: options.userId ?? userA,
        key: options.key ?? "key-1",
        route: options.route ?? ROUTE,
        requestHash: options.requestHash ?? "hash-1",
      },
      action,
    ),
  );
}

/** An action that counts its runs and answers `{ status, body }`. */
function countingAction(status: number, body: object): { run: () => Promise<IdempotentResponse>; calls: () => number } {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      return { status, body };
    },
    calls: () => calls,
  };
}

interface StoredRow {
  user_id: string;
  key: string;
  route: string;
  request_hash: string;
  status: number;
  body: unknown;
}

async function storedRows(tenantId = tenantA): Promise<StoredRow[]> {
  return inTenantTransaction(tenantId, async (client) => {
    const { rows } = await client.query<StoredRow>(
      "SELECT user_id, key, route, request_hash, status, body FROM idempotent_responses ORDER BY user_id, key, route",
    );
    return rows;
  });
}

/** Fixture SQL: the only way to age a row past its 24 hours, or to seed rows the store would not write. */
async function seedExpiredRows(tenantId: string, count: number): Promise<void> {
  await admin.query(
    `INSERT INTO idempotent_responses (tenant_id, user_id, key, route, request_hash, status, body, expires_at)
     SELECT $1, gen_random_uuid(), 'expired-' || g, 'GET /expired', 'h', 200, '{}'::jsonb, now() - interval '1 hour'
       FROM generate_series(1, $2::int) g`,
    [tenantId, count],
  );
}

async function expiredCount(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM idempotent_responses WHERE tenant_id = $1 AND expires_at <= now()",
    [tenantId],
  );
  return rows[0]?.n ?? -1;
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenantA = await createTestTenant(admin);
  tenantB = await createTestTenant(admin);
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
});

describe("runIdempotent (issue gh-1894)", () => {
  it("runs the action once, stores its response and answers a repeat of the same request from the store", async () => {
    const action = countingAction(200, { id: "card-1", name: "first" });

    const first = await call(action.run);
    const second = await call(action.run);

    expect(first).toEqual({ status: 200, body: { id: "card-1", name: "first" } });
    expect(second).toEqual(first);
    expect(action.calls()).toBe(1);
    expect(await storedRows()).toEqual([
      {
        user_id: userA,
        key: "key-1",
        route: ROUTE,
        request_hash: "hash-1",
        status: 200,
        body: { id: "card-1", name: "first" },
      },
    ]);
  });

  it("answers the first call as the database holds the body, so the first answer and a replay are the same JSON", async () => {
    // jsonb keeps object keys in its own order (shorter keys first), which a JSON.stringify of the action's object does not.
    const action = countingAction(200, { zz: 1, a: { yy: 2, b: 3 } });

    const first = await call(action.run);
    const second = await call(action.run);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first.body)).toBe('{"a":{"b":3,"yy":2},"zz":1}');
  });

  it("refuses the key of another request with validation_failed, runs nothing and keeps the stored response", async () => {
    const action = countingAction(200, { n: 1 });
    await call(action.run);

    const error = await call(action.run, { requestHash: "hash-2" }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "Idempotency-Key" },
    });
    expect(action.calls()).toBe(1);
    expect(await storedRows()).toMatchObject([{ request_hash: "hash-1", body: { n: 1 } }]);
  });

  it("runs the action for a different user, a different route and a different key of the same tenant", async () => {
    const action = countingAction(200, { n: 1 });
    await call(action.run);

    await call(action.run, { userId: userB });
    await call(action.run, { route: OTHER_ROUTE });
    await call(action.run, { key: "key-2" });

    expect(action.calls()).toBe(4);
    expect(await storedRows()).toHaveLength(4);
  });

  it.each([
    ["a validation failure", 400],
    ["a conflict", 409],
    ["a server failure", 500],
  ])("answers %s and does not store it, so the next call with the key runs the action", async (_label, status) => {
    const failing = countingAction(status, { error: { code: "failed" } });
    const succeeding = countingAction(200, { ok: true });

    const failed = await call(failing.run);
    const retried = await call(succeeding.run);

    expect(failed).toEqual({ status, body: { error: { code: "failed" } } });
    expect(retried).toEqual({ status: 200, body: { ok: true } });
    expect(await storedRows()).toMatchObject([{ status: 200, body: { ok: true } }]);
  });

  it("rolls the transaction back and stores nothing when the action throws, so the key stays free", async () => {
    await expect(
      call(async () => {
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");
    const action = countingAction(200, { ok: true });

    const retried = await call(action.run);

    expect(retried.status).toBe(200);
    expect(action.calls()).toBe(1);
    expect(await storedRows()).toHaveLength(1);
  });

  it("ignores a row that has expired, runs the action again and replaces the row, even for another request hash", async () => {
    const first = countingAction(200, { n: 1 });
    await call(first.run);
    // Fixture SQL: the only way to age a row past its 24 hours.
    await admin.query("UPDATE idempotent_responses SET expires_at = now() - interval '1 second' WHERE tenant_id = $1", [
      tenantA,
    ]);
    const second = countingAction(200, { n: 2 });

    const answered = await call(second.run, { requestHash: "hash-2" });

    expect(answered).toEqual({ status: 200, body: { n: 2 } });
    expect(second.calls()).toBe(1);
    const rows = await storedRows();
    expect(rows).toMatchObject([{ request_hash: "hash-2", body: { n: 2 } }]);
    const { rows: expiry } = await admin.query<{ hours: number }>(
      "SELECT extract(epoch FROM expires_at - created_at)::int / 3600 AS hours FROM idempotent_responses WHERE tenant_id = $1",
      [tenantA],
    );
    expect(expiry).toEqual([{ hours: 24 }]);
  });

  it("answers a row that is within its 24 hours", async () => {
    const first = countingAction(200, { n: 1 });
    await call(first.run);
    // Fixture SQL: moves the row to the last second of its 24 hours.
    await admin.query("UPDATE idempotent_responses SET expires_at = now() + interval '1 minute' WHERE tenant_id = $1", [
      tenantA,
    ]);
    const second = countingAction(200, { n: 2 });

    const answered = await call(second.run);

    expect(answered).toEqual({ status: 200, body: { n: 1 } });
    expect(second.calls()).toBe(0);
  });

  it("deletes one bounded batch of the tenant's expired rows with each stored response and none of another tenant's", async () => {
    await seedExpiredRows(tenantA, 101);
    await seedExpiredRows(tenantB, 3);

    await call(countingAction(200, { n: 1 }).run);

    expect(await expiredCount(tenantA)).toBe(1);
    expect(await expiredCount(tenantB)).toBe(3);
    await call(countingAction(200, { n: 2 }).run, { key: "key-2" });
    expect(await expiredCount(tenantA)).toBe(0);
    expect(await storedRows()).toHaveLength(2);
  });

  it("deletes no expired row when the action answers a failure", async () => {
    await seedExpiredRows(tenantA, 2);

    await call(countingAction(409, { error: { code: "version_conflict" } }).run);

    expect(await expiredCount(tenantA)).toBe(2);
  });

  it("holds the key per tenant: the same key, user and route in another tenant runs its own action", async () => {
    const forA = countingAction(200, { tenant: "a" });
    const forB = countingAction(200, { tenant: "b" });
    await call(forA.run);

    const answered = await call(forB.run, { tenantId: tenantB });

    expect(answered).toEqual({ status: 200, body: { tenant: "b" } });
    expect(forB.calls()).toBe(1);
    expect(await storedRows(tenantA)).toMatchObject([{ body: { tenant: "a" } }]);
    expect(await storedRows(tenantB)).toMatchObject([{ body: { tenant: "b" } }]);
  });

  it("shows tenant B no row of tenant A through the runtime role, and refuses it a row of tenant A's", async () => {
    await call(countingAction(200, { tenant: "a" }).run);

    expect(await storedRows(tenantB)).toEqual([]);
    const refused = await inTenantTransaction(tenantB, (client) =>
      client.query(
        `INSERT INTO idempotent_responses (tenant_id, user_id, key, route, request_hash, status, body, expires_at)
         VALUES ($1, $2, 'k', 'r', 'h', 200, '{}'::jsonb, now() + interval '1 hour')`,
        [tenantA, userA],
      ),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toMatchObject({ code: "42501" });
  });

  it("refuses a missing scope and a system scope without running the action", async () => {
    const action = countingAction(200, { n: 1 });
    const scopes: (TenantScope | undefined)[] = [undefined, { kind: "system", reason: "test" }];

    for (const tenantScope of scopes) {
      await expect(
        inTenantTransaction(tenantA, (client) =>
          runIdempotent(
            client,
            { tenantScope, userId: userA, key: "key-1", route: ROUTE, requestHash: "hash-1" },
            action.run,
          ),
        ),
      ).rejects.toThrow("requires an active tenant scope");
    }

    expect(action.calls()).toBe(0);
    expect(await storedRows()).toEqual([]);
  });

  it("refuses a client that is not in a managed transaction without running the action", async () => {
    const action = countingAction(200, { n: 1 });
    const client = await runInTenant(tenantA, () => runtime.connect());
    try {
      await expect(
        runIdempotent(
          client,
          {
            tenantScope: { kind: "tenant", tenantId: tenantA },
            userId: userA,
            key: "k",
            route: ROUTE,
            requestHash: "h",
          },
          action.run,
        ),
      ).rejects.toThrow("managed transaction");
    } finally {
      client.release();
    }
    expect(action.calls()).toBe(0);
  });

  it("refuses to answer a stored body that is not a JSON object", async () => {
    // Fixture SQL: a row the store itself never writes.
    await admin.query(
      `INSERT INTO idempotent_responses (tenant_id, user_id, key, route, request_hash, status, body, expires_at)
       VALUES ($1, $2, 'key-1', $3, 'hash-1', 200, '"text"'::jsonb, now() + interval '1 hour')`,
      [tenantA, userA, ROUTE],
    );
    const action = countingAction(200, { n: 1 });

    await expect(call(action.run)).rejects.toThrow("not a JSON object");

    expect(action.calls()).toBe(0);
  });

  it("serializes two concurrent calls of one key: the second waits for the first and answers its response", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const action = async (): Promise<IdempotentResponse> => {
      calls += 1;
      started();
      await gate;
      return { status: 200, body: { run: calls } };
    };

    const first = call(action);
    await firstStarted;
    const second = call(action);
    // The second call is queued on the key's advisory lock; waiting for it to show there proves it did not run.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await admin.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
      );
      if ((rows[0]?.waiting ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error("the second call never waited on the advisory lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(calls).toBe(1);
    release();

    const answers = await Promise.all([first, second]);

    expect(answers[0]).toEqual({ status: 200, body: { run: 1 } });
    expect(answers[1]).toEqual(answers[0]);
    expect(calls).toBe(1);
    expect(await storedRows()).toHaveLength(1);
  });

  it("lets the second of two concurrent calls run its own action when the first one failed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const failing = async (): Promise<IdempotentResponse> => {
      started();
      await gate;
      throw new Error("the first action failed");
    };
    const succeeding = countingAction(200, { ok: true });

    const first = call(failing).then(
      () => null,
      (err: unknown) => err,
    );
    await firstStarted;
    const second = call(succeeding.run);
    release();

    expect(await first).toBeInstanceOf(Error);
    expect(await second).toEqual({ status: 200, body: { ok: true } });
    expect(succeeding.calls()).toBe(1);
  });
});

describe("hashIdempotentRequest", () => {
  it("is the same for equal requests whatever their key order and differs when a value differs", () => {
    const hash = hashIdempotentRequest({ proposalId: "p", body: { set: { primary: { a: 1, b: 2 } } } });

    expect(hashIdempotentRequest({ body: { set: { primary: { b: 2, a: 1 } } }, proposalId: "p" })).toBe(hash);
    expect(hashIdempotentRequest({ proposalId: "p", body: { set: { primary: { a: 1, b: 3 } } } })).not.toBe(hash);
    expect(hashIdempotentRequest({ proposalId: "q", body: { set: { primary: { a: 1, b: 2 } } } })).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readIdempotencyKeyHeader", () => {
  it.each([
    ["no headers", undefined],
    ["no such header", {}],
    ["an empty header", { "idempotency-key": "" }],
  ])("answers undefined for %s", (_label, headers) => {
    expect(readIdempotencyKeyHeader(headers)).toBeUndefined();
  });

  it("answers the key of a single header value up to 255 characters", () => {
    expect(readIdempotencyKeyHeader({ "idempotency-key": "k-1" })).toBe("k-1");
    expect(readIdempotencyKeyHeader({ "idempotency-key": "k".repeat(255) })).toBe("k".repeat(255));
  });

  it.each([
    ["a key of 256 characters", "k".repeat(256)],
    ["several header values", ["a", "b"]],
  ])("refuses %s with a validation_failed on the header", (_label, value) => {
    expect(() => readIdempotencyKeyHeader({ "idempotency-key": value })).toThrow(
      expect.objectContaining({ code: "validation_failed", details: { field: "Idempotency-Key" } }),
    );
  });
});

describe("the item purge hook of the Processing proposals cards (issue gh-1894)", () => {
  const storage: BlobStorageWriter = {
    writeStream: () => Promise.reject(new Error("not used by the purge")),
    readStream: () => {
      throw new Error("not used by the purge");
    },
    delete: async () => {},
  };

  /** A Processing proposals card or a Tasks item of `tenantId`, trashed and aged past the trash retention. */
  async function trashedItemOf(tenantId: string, moduleId: "processingProposals" | "tasks"): Promise<void> {
    const trashed = await runInTenant(tenantId, async () => {
      await seedSystem(runtime);
      return withTransaction(runtime, async (client) => {
        const database = await getDatabaseByModuleId(client, moduleId);
        if (!database) throw new Error(`${moduleId} was not seeded`);
        const envelope = { entityKind: "database", target: database.id, properties: { name: "Purged" } };
        const item = await createItemWithClient(
          client,
          {
            databaseId: database.id,
            properties:
              moduleId === "tasks"
                ? { name: "Purged" }
                : { kind: "inbox", status: "proposed", proposal: envelope, aiProposal: envelope },
          },
          { allowedSystemKeys: ["kind", "status", "proposal", "aiProposal"] },
        );
        return { databaseId: database.id, itemId: item.id };
      });
    });
    await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(trashed.databaseId, trashed.itemId));
    // Fixture SQL: the only way to age a trashed row past the 30 days retention.
    await admin.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1 AND database_id = $2", [
      trashed.itemId,
      trashed.databaseId,
    ]);
  }

  it("deletes the tenant's expired stored responses when a card is permanently deleted, and no other tenant's", async () => {
    await trashedItemOf(tenantA, "processingProposals");
    await call(countingAction(200, { live: true }).run, { key: "key-live" });
    await seedExpiredRows(tenantA, 3);
    await seedExpiredRows(tenantB, 2);

    expect(await runInTenant(tenantA, () => purgeExpiredTrash(runtime, storage))).toBe(1);

    expect(await expiredCount(tenantA)).toBe(0);
    expect(await expiredCount(tenantB)).toBe(2);
    expect(await storedRows()).toMatchObject([{ key: "key-live" }]);
  });

  it("leaves the expired rows when an item of another database is permanently deleted", async () => {
    await trashedItemOf(tenantA, "tasks");
    await seedExpiredRows(tenantA, 3);

    expect(await runInTenant(tenantA, () => purgeExpiredTrash(runtime, storage))).toBe(1);

    expect(await expiredCount(tenantA)).toBe(3);
  });
});
