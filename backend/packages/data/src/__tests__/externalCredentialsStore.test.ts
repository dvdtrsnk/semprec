import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { encryptSecret, openSecret, resolveMasterKeyFromEnv } from "@semprec/credentials";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { getTenantDataKey } from "../credentials/tenantKeysStore.js";
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

interface StoredRow {
  tenant_id: string;
  scheme: string;
  key_version: number;
  credential_type: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

async function storedRows(itemId: string): Promise<StoredRow[]> {
  const { rows } = await pool.query<StoredRow>(
    `SELECT tenant_id, scheme, key_version, credential_type, ciphertext, nonce
       FROM external_credentials WHERE item_id = $1`,
    [itemId],
  );
  return rows;
}

async function tenantKeyCount(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM tenant_keys WHERE tenant_id = $1", [
    tenantId,
  ]);
  return Number(rows[0]?.n);
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

  describe("writing", () => {
    it("storeCredential in tenant zero writes a tenant row bound to the tenant and item, logged once on read", async () => {
      const tenantZero = getTenantZeroId();
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "s3cret" });

      const rows = await storedRows(itemId);
      expect(rows.map((r) => ({ tenantId: r.tenant_id, scheme: r.scheme, keyVersion: r.key_version }))).toEqual([
        { tenantId: tenantZero, scheme: "tenant", keyVersion: 1 },
      ]);
      const key = await getTenantDataKey(pool);
      expect(key?.tenantId).toBe(tenantZero);
      const [row] = rows;
      if (!row || !key) throw new Error("expected a stored row and a tenant key");
      const opened = await openSecret(
        { ciphertext: row.ciphertext, nonce: row.nonce },
        key.dataKey,
        associatedData(tenantZero, itemId),
      );
      expect(opened.toString("utf8")).toBe("s3cret");

      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("s3cret");
      expect(await logCount(itemId)).toBe(1);
    });

    it("storeCredential over a master row turns it into a tenant row with the new plaintext", async () => {
      const itemId = randomUUID();
      const sealed = await encryptSecret("old", resolveMasterKeyFromEnv(1));
      // Raw SQL: `storeCredential` no longer writes `master` rows, but rows written before it remain.
      await pool.query(
        `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, key_version, scheme)
         VALUES ($1, 'api_key', $2, $3, 1, 'master')`,
        [itemId, sealed.ciphertext, sealed.nonce],
      );
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("old");

      await storeCredential(pool, { itemId, credentialType: "bearer_token", plaintext: "new" });

      expect((await storedRows(itemId)).map((r) => ({ scheme: r.scheme, type: r.credential_type }))).toEqual([
        { scheme: "tenant", type: "bearer_token" },
      ]);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("new");
    });

    it("storeCredential over a tenant row replaces its ciphertext", async () => {
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "first" });
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "second" });
      expect((await storedRows(itemId)).map((r) => r.scheme)).toEqual(["tenant"]);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("second");
    });

    it("in a tenant without a key, a committed store creates the key and a row of that tenant", async () => {
      const tenantB = await createTestTenant(pool);
      const itemId = randomUUID();
      expect(await tenantKeyCount(tenantB)).toBe(0);

      await withTenantTransaction(dataPool, tenantB, (c) =>
        storeCredential(c, { itemId, credentialType: "api_key", plaintext: "b-secret" }),
      );

      expect(await tenantKeyCount(tenantB)).toBe(1);
      expect((await storedRows(itemId)).map((r) => ({ tenantId: r.tenant_id, scheme: r.scheme }))).toEqual([
        { tenantId: tenantB, scheme: "tenant" },
      ]);
      expect(
        await withTenantTransaction(dataPool, tenantB, (c) => getDecryptedCredential(c, { itemId, ...READ })),
      ).toBe("b-secret");
    });

    it("in a tenant without a key, a store inside a transaction that then throws leaves neither credential nor key", async () => {
      const tenantB = await createTestTenant(pool);
      const itemId = randomUUID();

      await expect(
        withTenantTransaction(dataPool, tenantB, async (c) => {
          await storeCredential(c, { itemId, credentialType: "api_key", plaintext: "b-secret" });
          throw new Error("caller failed after storing");
        }),
      ).rejects.toThrow("caller failed after storing");

      expect(await storedRows(itemId)).toEqual([]);
      expect(await tenantKeyCount(tenantB)).toBe(0);
    });
  });

  describe("master rows", () => {
    it("a row inserted without scheme reads back as master and decrypts, one log row per attempt", async () => {
      const itemId = randomUUID();
      const sealed = await encryptSecret("legacy", resolveMasterKeyFromEnv(1));
      // Raw SQL: the previous release's insert omits `scheme`; no current writer produces this row.
      await pool.query(
        `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, key_version)
         VALUES ($1, 'api_key', $2, $3, 1)`,
        [itemId, sealed.ciphertext, sealed.nonce],
      );
      expect((await storedRows(itemId)).map((r) => r.scheme)).toEqual(["master"]);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("legacy");
      expect(await logCount(itemId)).toBe(1);
      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("legacy");
      expect(await logCount(itemId)).toBe(2);
    });
  });

  describe("binding", () => {
    it("refuses a ciphertext copied from another item and still logs the attempt", async () => {
      const itemX = randomUUID();
      const itemY = randomUUID();
      await storeCredential(pool, { itemId: itemX, credentialType: "api_key", plaintext: "x-secret" });
      await storeCredential(pool, { itemId: itemY, credentialType: "api_key", plaintext: "y-secret" });
      // Raw SQL: copying a ciphertext between rows is the tampering this case simulates.
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
      await withTenantTransaction(dataPool, tenantA, (c) =>
        storeCredential(c, { itemId: itemA, credentialType: "api_key", plaintext: "a-secret" }),
      );
      await withTenantTransaction(dataPool, tenantB, (c) =>
        storeCredential(c, { itemId: itemB, credentialType: "api_key", plaintext: "b-secret" }),
      );
      expect(
        await withTenantTransaction(dataPool, tenantB, (c) => getDecryptedCredential(c, { itemId: itemB, ...READ })),
      ).toBe("b-secret");

      const [rowA] = await storedRows(itemA);
      // Raw SQL on the admin pool: a cross-tenant copy is the tampering this case simulates.
      await pool.query("UPDATE external_credentials SET ciphertext = $1, nonce = $2 WHERE item_id = $3", [
        rowA?.ciphertext,
        rowA?.nonce,
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
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "gone" });
      await pool.query("DELETE FROM tenant_keys");
      await expectNoCode(getDecryptedCredential(pool, { itemId, ...READ }));
      expect(await logCount(itemId)).toBe(1);
    });
  });

  describe("error shape", () => {
    it("the missing-key error carries no code", async () => {
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "x" });
      await pool.query("DELETE FROM tenant_keys");
      await expect(getDecryptedCredential(pool, { itemId, ...READ })).rejects.toThrow(
        "No data key for this credential's tenant",
      );
      await expectNoCode(getDecryptedCredential(pool, { itemId, ...READ }));
    });
  });
});
