import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { encryptSecret, resolveMasterKeyFromEnv } from "@semprec/credentials";
import { runAsSystem } from "@semprec/shared";
import {
  getDecryptedCredential,
  reencryptCredentialUnderTenantKey,
  storeCredential,
} from "../credentials/externalCredentialsStore.js";
import { logger } from "../credentials/logger.js";
import { handleCredentialReencryptSweepTask } from "../credentials/reencryptCredentialsJob.js";
import { logger as tenancyLogger } from "../tenancy/logger.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantZero: string;
let tenantB: string;

const READ = { actorType: "sync_worker", purpose: "test" } as const;

interface StoredRow {
  item_id: string;
  tenant_id: string;
  scheme: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

/** Inserts a `master` row in `tenantId` and returns its master ciphertext. */
async function insertMasterRow(tenantId: string, itemId: string, plaintext: string): Promise<Buffer> {
  const sealed = await encryptSecret(plaintext, resolveMasterKeyFromEnv(1));
  // Raw SQL: since #1060 no writer produces a `master` row; the previous release's insert omits `scheme`.
  await withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, key_version)
       VALUES ($1, 'api_key', $2, $3, 1)`,
      [itemId, sealed.ciphertext, sealed.nonce],
    ),
  );
  return sealed.ciphertext;
}

/** Every credential row, read on the admin pool so both tenants are visible. */
async function allRows(): Promise<StoredRow[]> {
  const { rows } = await adminPool.query<StoredRow>(
    "SELECT item_id, tenant_id, scheme, ciphertext, nonce FROM external_credentials ORDER BY item_id",
  );
  return rows;
}

async function rowOf(itemId: string): Promise<StoredRow | undefined> {
  return (await allRows()).find((row) => row.item_id === itemId);
}

async function tenantKeyTenants(): Promise<string[]> {
  const { rows } = await adminPool.query<{ tenant_id: string }>("SELECT tenant_id FROM tenant_keys ORDER BY tenant_id");
  return rows.map((row) => row.tenant_id);
}

async function accessLogCount(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM credential_access_log");
  return rows[0]?.n ?? -1;
}

function sweep(): Promise<void> {
  return runAsSystem("test", () => handleCredentialReencryptSweepTask(pool));
}

/** The text of every logged argument, an error's name, message and stack included. */
function loggedText(calls: unknown[][]): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
}

describe("credential re-encryption under the tenant key (issue #1062)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantZero = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("the sweep", () => {
    it("re-seals tenant zero's 3 and tenant B's 2 master rows, each readable in its own tenant, one key per tenant", async () => {
      const seeded = [
        ...[1, 2, 3].map((n) => ({ tenantId: tenantZero, itemId: randomUUID(), plaintext: `zero-${n}` })),
        ...[1, 2].map((n) => ({ tenantId: tenantB, itemId: randomUUID(), plaintext: `b-${n}` })),
      ];
      for (const s of seeded) await insertMasterRow(s.tenantId, s.itemId, s.plaintext);

      await sweep();

      const rows = await allRows();
      expect(rows.map((row) => row.scheme)).toEqual(["tenant", "tenant", "tenant", "tenant", "tenant"]);
      for (const s of seeded) {
        expect((await rowOf(s.itemId))?.tenant_id).toBe(s.tenantId);
      }
      expect(await tenantKeyTenants()).toEqual([tenantZero, tenantB].sort());
      expect(await accessLogCount()).toBe(0);

      for (const s of seeded) {
        expect(
          await withTenantTransaction(pool, s.tenantId, (client) =>
            getDecryptedCredential(client, { itemId: s.itemId, ...READ }),
          ),
        ).toBe(s.plaintext);
      }
    });

    it("a second run changes nothing: every ciphertext stays byte-identical", async () => {
      await insertMasterRow(tenantZero, randomUUID(), "zero");
      await insertMasterRow(tenantB, randomUUID(), "b");
      await sweep();
      const afterFirst = await allRows();

      await sweep();

      const afterSecond = await allRows();
      expect(afterSecond).toEqual(afterFirst);
      expect(afterSecond.map((row) => row.scheme)).toEqual(["tenant", "tenant"]);
    });

    it("re-seals 101 master rows of one tenant in a single run", async () => {
      for (let n = 0; n < 101; n += 1) await insertMasterRow(tenantB, randomUUID(), `secret-${n}`);

      await sweep();

      const rows = await allRows();
      expect(rows).toHaveLength(101);
      expect(rows.filter((row) => row.scheme !== "tenant")).toEqual([]);
    });

    it("leaves a corrupted row master, re-seals the others, rejects, and logs the item id without the secret", async () => {
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.spyOn(tenancyLogger, "error").mockImplementation(() => {});
      const corruptId = randomUUID();
      const goodZero = randomUUID();
      const goodB = randomUUID();
      const ciphertext = await insertMasterRow(tenantZero, corruptId, "corrupt-plaintext");
      await insertMasterRow(tenantZero, goodZero, "good-zero");
      await insertMasterRow(tenantB, goodB, "good-b");
      const corrupted = Buffer.from(ciphertext);
      corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
      // Raw SQL on the admin pool: corrupting a stored ciphertext is the failure this case simulates.
      await adminPool.query("UPDATE external_credentials SET ciphertext = $1 WHERE item_id = $2", [
        corrupted,
        corruptId,
      ]);

      await expect(sweep()).rejects.toBeInstanceOf(AggregateError);

      expect((await rowOf(corruptId))?.scheme).toBe("master");
      expect((await rowOf(corruptId))?.ciphertext).toEqual(corrupted);
      expect((await rowOf(goodZero))?.scheme).toBe("tenant");
      expect((await rowOf(goodB))?.scheme).toBe("tenant");

      const failureCalls = errorSpy.mock.calls.filter(
        ([fields]) => typeof fields === "object" && fields !== null && Reflect.get(fields, "itemId") === corruptId,
      );
      expect(failureCalls).toHaveLength(1);
      const text = loggedText(errorSpy.mock.calls);
      expect(text).not.toContain("corrupt-plaintext");
      for (const bytes of [ciphertext, corrupted]) {
        expect(text).not.toContain(bytes.toString("hex"));
        expect(text).not.toContain(bytes.toString("base64"));
      }
      expect(await accessLogCount()).toBe(0);
    });
  });

  describe("reencryptCredentialUnderTenantKey", () => {
    it("returns false for a row storeCredential already replaced, leaving its ciphertext untouched", async () => {
      const itemId = randomUUID();
      await insertMasterRow(tenantZero, itemId, "old");
      await withTenantTransaction(pool, tenantZero, (client) =>
        storeCredential(client, { itemId, credentialType: "api_key", plaintext: "new" }),
      );
      const before = await rowOf(itemId);
      expect(before?.scheme).toBe("tenant");

      expect(
        await withTenantTransaction(pool, tenantZero, (client) => reencryptCredentialUnderTenantKey(client, itemId)),
      ).toBe(false);

      expect(await rowOf(itemId)).toEqual(before);
      expect(
        await withTenantTransaction(pool, tenantZero, (client) => getDecryptedCredential(client, { itemId, ...READ })),
      ).toBe("new");
    });

    it("on a superuser pool in tenant A's scope never selects or changes a row of tenant B", async () => {
      const tenantA = await createTestTenant(adminPool);
      const itemB = randomUUID();
      await insertMasterRow(tenantB, itemB, "b-secret");
      const before = await rowOf(itemB);

      expect(
        await withTenantTransaction(adminPool, tenantA, (client) => reencryptCredentialUnderTenantKey(client, itemB)),
      ).toBe(false);

      expect(await rowOf(itemB)).toEqual(before);
      expect(before?.scheme).toBe("master");
      expect(await tenantKeyTenants()).toEqual([]);
    });

    it("on a superuser pool re-seals a row of the scoped tenant itself", async () => {
      const itemB = randomUUID();
      await insertMasterRow(tenantB, itemB, "b-secret");

      expect(
        await withTenantTransaction(adminPool, tenantB, (client) => reencryptCredentialUnderTenantKey(client, itemB)),
      ).toBe(true);

      expect((await rowOf(itemB))?.scheme).toBe("tenant");
      expect(await tenantKeyTenants()).toEqual([tenantB]);
      expect(
        await withTenantTransaction(pool, tenantB, (client) =>
          getDecryptedCredential(client, { itemId: itemB, ...READ }),
        ),
      ).toBe("b-secret");
    });
  });
});
