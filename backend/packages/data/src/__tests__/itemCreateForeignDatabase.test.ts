import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { deleteDatabaseWithItems } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";

/**
 * A raw `items` insert naming another tenant's database or a random UUID fails with 23503 (composite
 * foreign key). `createItem` resolves the database under row-level security first, so both must get the
 * same NotFoundError and write nothing.
 */

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantA: string;
let tenantB: string;

interface ErrorShape {
  name: string;
  status: number;
  code: string;
  message: string;
  details: unknown;
}

async function notFound(fn: () => Promise<unknown>): Promise<ErrorShape> {
  const error: unknown = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NotFoundError);
  const e = error as NotFoundError;
  return { name: e.name, status: e.status, code: e.code, message: e.message, details: e.details };
}

async function writtenRows(): Promise<{ items: number; keys: number }> {
  const { rows } = await adminPool.query<{ items: number; keys: number }>(
    "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM idempotency_keys) AS keys",
  );
  return rows[0]!;
}

describe("createItem answers a foreign and an unknown database id identically (issue #1235)", () => {
  let databaseA: string;
  let databaseB: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
    chokePoint = createChokePoint(dataPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = await createTestTenant(adminPool);
    tenantB = await createTestTenant(adminPool);
    databaseA = (await runInTenant(tenantA, () => chokePoint.createDatabase({ name: "Tenant A" }))).id;
    databaseB = (await runInTenant(tenantB, () => chokePoint.createDatabase({ name: "Tenant B" }))).id;
  });

  for (const withKey of [false, true]) {
    const variant = withKey ? "with an idempotency key" : "without an idempotency key";

    it(`gives the same NotFoundError for A's database and a random UUID, ${variant}, and writes no row`, async () => {
      const randomId = randomUUID();
      const before = await writtenRows();
      const create = (databaseId: string) =>
        notFound(() =>
          runInTenant(tenantB, () =>
            chokePoint.createItem({ databaseId, idempotencyKey: withKey ? randomUUID() : undefined }),
          ),
        );

      const foreign = await create(databaseA);
      const unknown = await create(randomId);

      // The message echoes the id the caller sent; with that input masked the errors are identical.
      const mask = (shape: ErrorShape, id: string): ErrorShape => ({
        ...shape,
        message: shape.message.replace(id, "<id>"),
      });
      expect(mask(foreign, databaseA)).toEqual(mask(unknown, randomId));
      expect(foreign).toEqual({
        name: "NotFoundError",
        status: 404,
        code: "not_found",
        message: `Database ${databaseA} not found`,
        details: undefined,
      });
      expect(await writtenRows()).toEqual(before);
    });

    it(`gives a byte-identical error for A's database before and after A drops it, ${variant}`, async () => {
      const before = await writtenRows();
      const create = () =>
        notFound(() =>
          runInTenant(tenantB, () =>
            chokePoint.createItem({ databaseId: databaseA, idempotencyKey: withKey ? "replay-key" : undefined }),
          ),
        );

      const whileForeign = await create();
      await runInTenant(tenantA, () =>
        withTransaction(dataPool, (client) => deleteDatabaseWithItems(client, databaseA)),
      );
      const onceUnknown = await create();

      expect(whileForeign).toEqual(onceUnknown);
      expect(await writtenRows()).toEqual(before);
    });

    it(`creates the item in B's own database, ${variant}`, async () => {
      const item = await runInTenant(tenantB, () =>
        chokePoint.createItem({ databaseId: databaseB, idempotencyKey: withKey ? randomUUID() : undefined }),
      );
      expect(item.databaseId).toBe(databaseB);
      const { rows } = await adminPool.query<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM items WHERE database_id = $1",
        [databaseB],
      );
      expect(rows).toEqual([{ id: item.id, tenant_id: tenantB }]);
    });
  }
});
