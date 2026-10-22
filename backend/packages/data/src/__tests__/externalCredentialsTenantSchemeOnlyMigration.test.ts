import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { getTenantZeroId, getTestPool, resetDatabase, withTenantTransaction } from "../testSupport/testDb.js";

/**
 * Issue #1069, the contract step of the per-tenant credential encryption. The migration already ran
 * in `globalSetup`, so each case re-runs its SQL inside one transaction on a dedicated superuser
 * client, after recreating the pre-migration schema there (constraint dropped), and rolls back at the
 * end so the shared test database keeps the migrated schema.
 */
const MIGRATION_SQL = await readFile(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../db/migrations/0086_external_credentials_tenant_scheme_only.sql",
  ),
  "utf8",
);
const CONSTRAINT = "external_credentials_scheme_tenant_only";
const RETIRED_TASK = "credentialReencryptSweep";

let adminPool: Pool;

interface CredentialRow {
  scheme: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

async function readRow(client: PoolClient, itemId: string): Promise<CredentialRow[]> {
  const { rows } = await client.query<CredentialRow>(
    "SELECT scheme, ciphertext, nonce FROM external_credentials WHERE item_id = $1",
    [itemId],
  );
  return rows;
}

/** Runs `fn` in a transaction where the constraint is absent again, and always rolls it back. */
async function withPreMigrationSchema(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await adminPool.connect();
  let failure: { error: unknown } | undefined;
  try {
    await client.query("BEGIN");
    // Owner DDL: the pre-migration schema is a state only a test can recreate once the migration ran.
    await client.query(`ALTER TABLE external_credentials DROP CONSTRAINT ${CONSTRAINT}`);
    await fn(client);
  } catch (error) {
    failure = { error };
  }
  let rollbackError: Error | undefined;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    rollbackError = error instanceof Error ? error : new Error(String(error));
  }
  // A client whose rollback failed may still sit in the transaction that dropped the constraint: destroy it.
  client.release(rollbackError !== undefined);
  // The case's own failure wins over a rollback failure.
  if (failure) throw failure.error;
  if (rollbackError !== undefined) throw rollbackError;
}

/** Inserts a `master` row raw: since #1060 no writer produces one, so only SQL can recreate it. */
async function insertMasterRow(client: PoolClient, itemId: string): Promise<void> {
  await client.query(
    `INSERT INTO external_credentials (tenant_id, item_id, credential_type, ciphertext, nonce, key_version, scheme)
     VALUES ($1, $2, 'api_key', '\\x0102'::bytea, '\\x0304'::bytea, 1, 'master')`,
    [getTenantZeroId(), itemId],
  );
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: unknown; constraint?: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as { code?: unknown; constraint?: unknown };
}

async function constraintExists(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'external_credentials'::regclass AND conname = $1) AS present",
    [CONSTRAINT],
  );
  return rows[0]?.present ?? false;
}

async function jobIdentifiers(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ task_identifier: string }>(
    "SELECT task_identifier FROM graphile_worker.jobs ORDER BY task_identifier",
  );
  return rows.map((row) => row.task_identifier);
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

describe("0086_external_credentials_tenant_scheme_only (issue #1069)", () => {
  it("fails while a master row exists and leaves that row unchanged", async () => {
    const itemId = randomUUID();
    await withPreMigrationSchema(async (client) => {
      await insertMasterRow(client, itemId);
      const before = await readRow(client, itemId);

      await client.query("SAVEPOINT migration");
      const failure = await errorOf(client.query(MIGRATION_SQL));
      expect({ code: failure.code, constraint: failure.constraint }).toEqual({ code: "23514", constraint: CONSTRAINT });
      await client.query("ROLLBACK TO SAVEPOINT migration");

      expect(await readRow(client, itemId)).toEqual(before);
      expect(before.map((row) => row.scheme)).toEqual(["master"]);
      expect(await constraintExists(client)).toBe(false);
    });
  });

  it("succeeds with only tenant rows, then refuses a master row and a row without scheme", async () => {
    const itemId = randomUUID();
    await withTenantTransaction(adminPool, getTenantZeroId(), (client) =>
      storeCredential(client, { itemId, credentialType: "api_key", plaintext: "kept" }),
    );

    await withPreMigrationSchema(async (client) => {
      const before = await readRow(client, itemId);
      await client.query(MIGRATION_SQL);
      expect(await constraintExists(client)).toBe(true);
      expect(await readRow(client, itemId)).toEqual(before);

      await client.query("SAVEPOINT master_insert");
      const master = await errorOf(insertMasterRow(client, randomUUID()));
      expect({ code: master.code, constraint: master.constraint }).toEqual({ code: "23514", constraint: CONSTRAINT });
      await client.query("ROLLBACK TO SAVEPOINT master_insert");

      await client.query("SAVEPOINT defaulted_insert");
      const defaulted = await errorOf(
        client.query(
          `INSERT INTO external_credentials (tenant_id, item_id, credential_type, ciphertext, nonce, key_version)
           VALUES ($1, $2, 'api_key', '\\x0102'::bytea, '\\x0304'::bytea, 1)`,
          [getTenantZeroId(), randomUUID()],
        ),
      );
      expect({ code: defaulted.code, constraint: defaulted.constraint }).toEqual({
        code: "23514",
        constraint: CONSTRAINT,
      });
      await client.query("ROLLBACK TO SAVEPOINT defaulted_insert");

      const { rows } = await client.query<{ n: string }>("SELECT count(*) AS n FROM external_credentials");
      expect(Number(rows[0]?.n)).toBe(1);
    });
  });

  it("completes a pending credentialReencryptSweep job and leaves other jobs queued", async () => {
    await withPreMigrationSchema(async (client) => {
      // graphile-worker's public SQL API: the retired task has no producer left in the code.
      await client.query("SELECT graphile_worker.add_job($1)", [RETIRED_TASK]);
      await client.query("SELECT graphile_worker.add_job($1)", ["unrelatedProbeTask"]);
      expect(await jobIdentifiers(client)).toEqual([RETIRED_TASK, "unrelatedProbeTask"]);

      await client.query(MIGRATION_SQL);

      expect(await jobIdentifiers(client)).toEqual(["unrelatedProbeTask"]);
    });
  });

  it("succeeds on a database without the graphile_worker schema", async () => {
    await withPreMigrationSchema(async (client) => {
      // Rolled back with the transaction: hides the schema the way a fresh install lacks it at migration time.
      await client.query("ALTER SCHEMA graphile_worker RENAME TO graphile_worker_hidden_by_test");
      const { rows } = await client.query<{ present: boolean }>(
        "SELECT to_regnamespace('graphile_worker') IS NOT NULL AS present",
      );
      expect(rows[0]?.present).toBe(false);

      await client.query(MIGRATION_SQL);

      expect(await constraintExists(client)).toBe(true);
    });
  });
});
