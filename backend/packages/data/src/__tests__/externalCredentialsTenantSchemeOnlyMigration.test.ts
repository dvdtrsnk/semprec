import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import {
  getTenantZeroId,
  getTestPool,
  insertItemsWithIds,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

/** The schema admits only the tenant credential scheme. */
const CONSTRAINT = "external_credentials_scheme_tenant_only";

let adminPool: Pool;

async function errorOf(promise: Promise<unknown>): Promise<{ code?: unknown; constraint?: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as { code?: unknown; constraint?: unknown };
}

beforeAll(() => {
  adminPool = getTestPool();
});

afterAll(async () => {
  await adminPool?.end();
});

beforeEach(async () => {
  await resetDatabase(adminPool);
});

describe("external_credentials scheme constraint (issue #1069)", () => {
  it("keeps a tenant row and refuses a master row and a row without scheme", async () => {
    const itemId = randomUUID();
    const masterItemId = randomUUID();
    const defaultedItemId = randomUUID();
    await withTenantTransaction(adminPool, getTenantZeroId(), async (client) => {
      // Real items for every row, so only the scheme constraint can refuse the raw inserts below.
      await insertItemsWithIds(client, [itemId, masterItemId, defaultedItemId]);
      await storeCredential(client, { itemId, credentialType: "api_key", plaintext: "kept" });
    });

    // Raw SQL: no writer produces a master row, so only SQL can attempt one.
    const master = await errorOf(
      adminPool.query(
        `INSERT INTO external_credentials (tenant_id, item_id, credential_type, ciphertext, nonce, key_version, scheme)
         VALUES ($1, $2, 'api_key', '\\x0102'::bytea, '\\x0304'::bytea, 1, 'master')`,
        [getTenantZeroId(), masterItemId],
      ),
    );
    expect({ code: master.code, constraint: master.constraint }).toEqual({ code: "23514", constraint: CONSTRAINT });

    const defaulted = await errorOf(
      adminPool.query(
        `INSERT INTO external_credentials (tenant_id, item_id, credential_type, ciphertext, nonce, key_version)
         VALUES ($1, $2, 'api_key', '\\x0102'::bytea, '\\x0304'::bytea, 1)`,
        [getTenantZeroId(), defaultedItemId],
      ),
    );
    expect({ code: defaulted.code, constraint: defaulted.constraint }).toEqual({
      code: "23514",
      constraint: CONSTRAINT,
    });

    const { rows } = await adminPool.query<{ n: string }>("SELECT count(*) AS n FROM external_credentials");
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
