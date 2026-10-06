import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { sealSecret } from "@semprec/credentials";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { getOrCreateTenantDataKey } from "../credentials/tenantKeysStore.js";
import type { Queryable } from "../db/pool.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let pool: Pool;
let dataPool: Pool;

const READ = { actorType: "sync_worker", purpose: "test" } as const;

/** The associated-data bytes the tenant scheme is documented to use. */
function associatedData(tenantId: string, itemId: string): Buffer {
  return Buffer.from(`semprec:external-credential:v1:${tenantId}:${itemId}`, "utf8");
}

/** Writes a `tenant` row the way the later release will: tenant key, sealSecret, raw insert. */
async function insertTenantRow(client: Queryable, tenantId: string, itemId: string, plaintext: string): Promise<void> {
  const { dataKey } = await getOrCreateTenantDataKey(client);
  const sealed = await sealSecret(plaintext, dataKey, associatedData(tenantId, itemId));
  await client.query(
    `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, scheme)
     VALUES ($1, 'api_key', $2, $3, 'tenant')`,
    [itemId, sealed.ciphertext, sealed.nonce],
  );
}

async function logCount(itemId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM credential_access_log WHERE item_id = $1",
    [itemId],
  );
  return Number(rows[0]?.n);
}

async function expectNoCode(promise: Promise<unknown>): Promise<void> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toHaveProperty("code");
}

describe("external credentials store, both schemes", () => {
  beforeAll(async () => {
    pool = getTestPool();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterAll(async () => {
    await dataPool?.end();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  describe("master rows", () => {
    it("storeCredential writes a master row that decrypts, one log row per attempt", async () => {
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "s3cret" });
      const { rows } = await pool.query<{ scheme: string }>(
        "SELECT scheme FROM external_credentials WHERE item_id = $1",
        [itemId],
      );
      expect(rows).toEqual([{ scheme: "master" }]);

      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("s3cret");
      expect(await logCount(itemId)).toBe(1);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("s3cret");
      expect(await logCount(itemId)).toBe(2);
    });

    it("a row inserted without scheme reads back as master and decrypts", async () => {
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "legacy" });
      const { rows: raw } = await pool.query<{ ciphertext: Buffer; nonce: Buffer }>(
        "SELECT ciphertext, nonce FROM external_credentials WHERE item_id = $1",
        [itemId],
      );
      await pool.query("DELETE FROM external_credentials WHERE item_id = $1", [itemId]);
      await pool.query(
        `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, key_version)
         VALUES ($1, 'api_key', $2, $3, 1)`,
        [itemId, raw[0]?.ciphertext, raw[0]?.nonce],
      );
      const { rows } = await pool.query<{ scheme: string }>(
        "SELECT scheme FROM external_credentials WHERE item_id = $1",
        [itemId],
      );
      expect(rows).toEqual([{ scheme: "master" }]);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("legacy");
    });
  });

  describe("tenant rows", () => {
    it("decrypts a fabricated tenant row and logs the attempt", async () => {
      const itemId = randomUUID();
      await insertTenantRow(pool, getTenantZeroId(), itemId, "tenant-secret");
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("tenant-secret");
      expect(await logCount(itemId)).toBe(1);
    });

    it("storeCredential over a tenant row turns it back into a master row", async () => {
      const itemId = randomUUID();
      await insertTenantRow(pool, getTenantZeroId(), itemId, "old");
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "new" });
      const { rows } = await pool.query<{ scheme: string }>(
        "SELECT scheme FROM external_credentials WHERE item_id = $1",
        [itemId],
      );
      expect(rows).toEqual([{ scheme: "master" }]);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("new");
    });
  });

  describe("binding", () => {
    it("refuses a ciphertext copied from another item and still logs the attempt", async () => {
      const itemX = randomUUID();
      const itemY = randomUUID();
      await insertTenantRow(pool, getTenantZeroId(), itemX, "x-secret");
      await insertTenantRow(pool, getTenantZeroId(), itemY, "y-secret");
      await pool.query(
        `UPDATE external_credentials AS y SET ciphertext = x.ciphertext, nonce = x.nonce
           FROM external_credentials AS x WHERE x.item_id = $1 AND y.item_id = $2`,
        [itemX, itemY],
      );
      expect(await getDecryptedCredential(pool, { itemId: itemX, ...READ })).toBe("x-secret");
      await expectNoCode(getDecryptedCredential(pool, { itemId: itemY, ...READ }));
      expect(await logCount(itemY)).toBe(1);
    });

    it("refuses tenant A's ciphertext copied onto a row of tenant B", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(pool);
      const itemA = randomUUID();
      const itemB = randomUUID();
      await withTenantTransaction(pool, tenantA, (c) => insertTenantRow(c, tenantA, itemA, "a-secret"));
      await withTenantTransaction(pool, tenantB, (c) => insertTenantRow(c, tenantB, itemB, "b-secret"));
      const { rows } = await pool.query<{ ciphertext: Buffer; nonce: Buffer }>(
        "SELECT ciphertext, nonce FROM external_credentials WHERE item_id = $1",
        [itemA],
      );
      await pool.query("UPDATE external_credentials SET ciphertext = $1, nonce = $2 WHERE item_id = $3", [
        rows[0]?.ciphertext,
        rows[0]?.nonce,
        itemB,
      ]);

      expect(
        await withTenantTransaction(dataPool, tenantA, (c) => getDecryptedCredential(c, { itemId: itemA, ...READ })),
      ).toBe("a-secret");
      await expectNoCode(
        withTenantTransaction(dataPool, tenantB, (c) => getDecryptedCredential(c, { itemId: itemB, ...READ })),
      );
    });

    it("throws once the tenant's key row is deleted", async () => {
      const itemId = randomUUID();
      await insertTenantRow(pool, getTenantZeroId(), itemId, "gone");
      await pool.query("DELETE FROM tenant_keys");
      await expectNoCode(getDecryptedCredential(pool, { itemId, ...READ }));
      expect(await logCount(itemId)).toBe(1);
    });
  });

  describe("error shape", () => {
    it("the missing-key error carries no code", async () => {
      const itemId = randomUUID();
      await insertTenantRow(pool, getTenantZeroId(), itemId, "x");
      await pool.query("DELETE FROM tenant_keys");
      await expect(getDecryptedCredential(pool, { itemId, ...READ })).rejects.toThrow(
        "No data key for this credential's tenant",
      );
      await expectNoCode(getDecryptedCredential(pool, { itemId, ...READ }));
    });
  });
});
