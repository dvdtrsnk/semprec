import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { openSecret, sealSecret } from "@semprec/credentials";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { getOrCreateTenantDataKey, getTenantDataKey } from "../credentials/tenantKeysStore.js";
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

/** The associated-data bytes the tenant scheme is documented to use: both ids as lowercase canonical UUID text. */
function associatedData(tenantId: string, itemId: string): Buffer {
  return Buffer.from(`semprec:external-credential:v1:${tenantId.toLowerCase()}:${itemId.toLowerCase()}`, "utf8");
}

/**
 * Seals a `tenant` row directly under the scope's tenant key with this file's associated data and inserts
 * it with raw SQL: the fixture's bytes are what is under test, which a row written by `storeCredential`
 * cannot show.
 */
async function insertTenantRow(client: Queryable, tenantId: string, itemId: string, plaintext: string): Promise<void> {
  const { dataKey } = await getOrCreateTenantDataKey(client);
  const sealed = await sealSecret(plaintext, dataKey, associatedData(tenantId, itemId));
  await client.query(
    `INSERT INTO external_credentials (tenant_id, item_id, credential_type, ciphertext, nonce, key_version, scheme)
     VALUES ($1, $2, 'api_key', $3, $4, 1, 'tenant')`,
    [tenantId, itemId, sealed.ciphertext, sealed.nonce],
  );
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

describe("external credentials store, tenant scheme only", () => {
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

  describe("fixture associated data", () => {
    it("a row sealed from uppercase tenant and item UUID text decrypts under the canonical ids", async () => {
      const tenantB = await createTestTenant(pool);
      const itemId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0fa1b2c3d4";
      const upperTenant = tenantB.toUpperCase();
      const upperItem = itemId.toUpperCase();
      // The case's premise: both ids contain letters, so their uppercase text differs from the canonical one.
      expect(upperTenant).not.toBe(tenantB);
      expect(upperItem).not.toBe(itemId);
      expect(associatedData(upperTenant, upperItem).equals(associatedData(tenantB, itemId))).toBe(true);

      await withTenantTransaction(dataPool, tenantB, (c) => insertTenantRow(c, upperTenant, upperItem, "upper-secret"));

      expect((await storedRows(itemId)).map((r) => r.tenant_id)).toEqual([tenantB]);
      expect(
        await withTenantTransaction(dataPool, tenantB, (c) => getDecryptedCredential(c, { itemId, ...READ })),
      ).toBe("upper-secret");
      expect(await logCount(itemId)).toBe(1);
    });
  });

  describe("scheme", () => {
    it("throws a plain error for a row whose scheme is not tenant, after logging the attempt", async () => {
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "x" });
      const client = await pool.connect();
      let failure: { error: unknown } | undefined;
      try {
        await client.query("BEGIN");
        // Owner DDL and raw SQL, rolled back below: migration 0086 forbids any other scheme, so only a
        // test that drops its constraint can produce the row this guard refuses.
        await client.query("ALTER TABLE external_credentials DROP CONSTRAINT external_credentials_scheme_tenant_only");
        await client.query("UPDATE external_credentials SET scheme = 'master' WHERE item_id = $1", [itemId]);

        const error: unknown = await getDecryptedCredential(client, { itemId, ...READ }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Unknown credential scheme in database row: 'master'");
        expect(error).not.toHaveProperty("code");
        const { rows } = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM credential_access_log WHERE item_id = $1",
          [itemId],
        );
        expect(Number(rows[0]?.n)).toBe(1);
      } catch (error) {
        failure = { error };
      }
      let rollbackError: Error | undefined;
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        rollbackError = error instanceof Error ? error : new Error(String(error));
      }
      client.release(rollbackError !== undefined);
      if (failure) throw failure.error;
      if (rollbackError !== undefined) throw rollbackError;

      expect(await getDecryptedCredential(pool, { itemId, ...READ })).toBe("x");
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
      // Caught inside the transaction so it commits the attempt's log row; a throwing callback would roll it back.
      await withTenantTransaction(dataPool, tenantB, async (c) => {
        await expectNoCode(getDecryptedCredential(c, { itemId: itemB, ...READ }));
      });
      expect(await logCount(itemB)).toBe(2);
    });

    it("refuses a corrupted ciphertext and still logs the attempt", async () => {
      const itemId = randomUUID();
      await storeCredential(pool, { itemId, credentialType: "api_key", plaintext: "intact" });
      // Raw SQL: flipping one ciphertext byte is the corruption this case simulates.
      await pool.query(
        "UPDATE external_credentials SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) WHERE item_id = $1",
        [itemId],
      );
      await expectNoCode(getDecryptedCredential(pool, { itemId, ...READ }));
      expect(await logCount(itemId)).toBe(1);
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
