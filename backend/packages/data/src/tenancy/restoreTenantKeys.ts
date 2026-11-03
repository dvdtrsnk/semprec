import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { RestorePostgresTools } from "./restorePostgresTools.js";

const BATCH_SIZE = 100;
const MAX_ROWS = 250_000;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const rowSchema = z
  .object({
    tenant_id: uuid,
    wrapped_key: z.instanceof(Buffer).refine((value) => value.length === 48),
    wrap_nonce: z.instanceof(Buffer).refine((value) => value.length === 24),
    master_key_version: z.number().int().min(1).max(32_767),
    created_at: z.string().min(1).max(80),
    finite: z.literal(true),
  })
  .strict();
const rlsSchema = z.object({ active: z.literal(true) }).strict();

/** Imports previously staged wrapped rows into an offline target under the target tenant's RLS. */
export async function importStagedTenantKeys(
  stage: PoolClient,
  target: Pool,
  recordTarget: (identity: { pid: number; backend_start: string }) => void,
  observer: Pool,
): Promise<void> {
  let after: string | null = null;
  let total = 0;
  while (true) {
    const result = await stage.query<Record<string, unknown>>(
      `SELECT tenant_id::text, wrapped_key, wrap_nonce, master_key_version,
              created_at::text, isfinite(created_at) AS finite
       FROM public.tenant_keys
       WHERE ($1::uuid IS NULL OR tenant_id > $1::uuid)
       ORDER BY tenant_id LIMIT $2`,
      [after, BATCH_SIZE],
    );
    const rows = z.array(rowSchema).max(BATCH_SIZE).parse(result.rows);
    if (rows.length === 0) return;
    total += rows.length;
    if (total > MAX_ROWS) throw new Error("Staged tenant key count exceeds its limit");
    for (const row of rows) {
      await runInTenant(row.tenant_id, () =>
        withTransaction(target, async (client) => {
          recordTarget(await targetBackendIdentity(client, observer));
          const rls = await client.query<Record<string, unknown>>(
            "SELECT row_security_active('public.tenant_keys') AS active",
          );
          if (rls.rows.length !== 1) throw new Error("Restore target role check failed");
          rlsSchema.parse(rls.rows[0]);
          const inserted = await client.query(
            `INSERT INTO public.tenant_keys (tenant_id, wrapped_key, wrap_nonce, master_key_version, created_at)
           SELECT $1::uuid, $2::bytea, $3::bytea, $4::smallint, $5::timestamptz
           WHERE EXISTS (SELECT 1 FROM public.tenants WHERE id = $1::uuid)`,
            [row.tenant_id, row.wrapped_key, row.wrap_nonce, row.master_key_version, row.created_at],
          );
          if (inserted.rowCount !== 0 && inserted.rowCount !== 1)
            throw new Error("Restore target write count is invalid");
        }),
      );
    }
    after = rows[rows.length - 1]?.tenant_id ?? null;
  }
}

interface DatabaseIdentity {
  system_id: string;
  database_name: string;
}

const identitySchema = z
  .object({
    system_id: z.string().regex(/^\d{1,20}$/),
    database_name: z.string().min(1).max(63),
  })
  .strict();
const backendSchema = z.object({ pid: z.number().int().positive(), backend_start: z.string().min(1) }).strict();
const presenceSchema = z.object({ present: z.boolean() }).strict();

export class RestoreStageUncertainError extends Error {
  constructor(
    readonly stageName: string,
    cause: unknown,
  ) {
    super("Offline restore staging cleanup was not established", { cause });
  }
}

async function identity(pool: Pool): Promise<DatabaseIdentity> {
  const result = await pool.query<Record<string, unknown>>(
    "SELECT system_identifier::text AS system_id, current_database() AS database_name FROM pg_control_system()",
  );
  if (result.rows.length !== 1) throw new Error("Restore database identity is unavailable");
  return identitySchema.parse(result.rows[0]);
}

async function backendIdentity(client: import("pg").PoolClient): Promise<{ pid: number; backend_start: string }> {
  const result = await client.query<Record<string, unknown>>(
    "SELECT pid, backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()",
  );
  if (result.rows.length !== 1) throw new Error("Restore database backend identity is unavailable");
  return backendSchema.parse(result.rows[0]);
}

async function targetBackendIdentity(
  client: PoolClient,
  observer: Pool,
): Promise<{ pid: number; backend_start: string }> {
  const readPid = async (): Promise<number> => {
    const result = await client.query<Record<string, unknown>>("SELECT pg_backend_pid() AS pid");
    if (result.rows.length !== 1) throw new Error("Restore target backend identity is unavailable");
    return z.object({ pid: z.number().int().positive() }).strict().parse(result.rows[0]).pid;
  };
  const pid = await readPid();
  const observed = await observer.query<Record<string, unknown>>(
    "SELECT pid, backend_start::text FROM pg_stat_activity WHERE pid = $1",
    [pid],
  );
  if (observed.rows.length !== 1) throw new Error("Restore target backend observation failed");
  const identityValue = backendSchema.parse(observed.rows[0]);
  if ((await readPid()) !== pid) throw new Error("Restore target backend changed during observation");
  return identityValue;
}

async function waitForBackend(observer: Pool, identityValue: { pid: number; backend_start: string }): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    const result = await observer.query<Record<string, unknown>>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
      [identityValue.pid, identityValue.backend_start],
    );
    if (result.rows.length !== 1) throw new Error("Restore database backend observation failed");
    if (!presenceSchema.parse(result.rows[0]).present) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  throw new Error("Restore database backend has not settled");
}

async function databasePresent(observer: Pool, name: string): Promise<boolean> {
  const result = await observer.query<Record<string, unknown>>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
    [name],
  );
  if (result.rows.length !== 1) throw new Error("Restore database observation failed");
  return presenceSchema.parse(result.rows[0]).present;
}

interface RestoreInput {
  adminUrl: string;
  targetUrl: string;
  targetRole?: "semprec_restore";
  container: string;
  archive: Buffer;
  recordStage: (name: string) => Promise<void>;
}

/** Restores keys only for tenants in an offline restored target; cleanup is part of success. */
export async function restoreTenantKeys(input: RestoreInput): Promise<void> {
  const poolConfig = { connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000, max: 1 };
  const admin = new Pool({ connectionString: input.adminUrl, ...poolConfig });
  const observer = new Pool({ connectionString: input.adminUrl, ...poolConfig });
  const target = new Pool({
    connectionString: input.targetUrl,
    ...poolConfig,
    options: input.targetRole ? `-c TimeZone=UTC -c role=${input.targetRole}` : "-c TimeZone=UTC",
  });
  const asynchronousFailures: unknown[] = [];
  for (const pool of [admin, observer, target]) pool.on("error", (error: unknown) => asynchronousFailures.push(error));
  const name = `semprec_restore_${randomUUID().replaceAll("-", "")}`;
  // A fixed prefix and UUID hex digits make this a closed SQL identifier.
  const identifier = `"${name}"`;
  let attemptOwned = false;
  let creatorSettled = false;
  let stageAbsent = false;
  let stage: Pool | undefined;
  let stageClient: PoolClient | undefined;
  let stageId: { pid: number; backend_start: string } | undefined;
  const targetIds = new Map<string, { pid: number; backend_start: string }>();
  const recordTarget = (value: { pid: number; backend_start: string }): void => {
    targetIds.set(`${value.pid}:${value.backend_start}`, value);
  };
  let creator: import("pg").PoolClient | undefined;
  let creatorId: { pid: number; backend_start: string } | undefined;
  let failure: { value: unknown } | undefined;
  const cleanup: unknown[] = [];
  try {
    const adminIdentity = await identity(admin);
    const targetClient = await target.connect();
    let targetCaptureFailure: { value: unknown } | undefined;
    try {
      recordTarget(await targetBackendIdentity(targetClient, observer));
    } catch (error) {
      targetCaptureFailure = { value: error };
    }
    try {
      targetClient.release(targetCaptureFailure ? true : undefined);
    } catch (error) {
      throw new AggregateError(
        targetCaptureFailure ? [targetCaptureFailure.value, error] : [error],
        "Restore target release failed",
        { cause: error },
      );
    }
    if (targetCaptureFailure) throw targetCaptureFailure.value;
    const targetIdentity = await identity(target);
    const tools = await RestorePostgresTools.connect(input.container);
    const containerIdentity = await tools.systemIdentifier();
    if (
      adminIdentity.system_id !== targetIdentity.system_id ||
      adminIdentity.system_id !== containerIdentity ||
      adminIdentity.database_name !== targetIdentity.database_name
    ) {
      throw new Error("Restore database identities do not match");
    }
    const roleResult = await target.query<Record<string, unknown>>(
      `SELECT row_security_active('public.tenant_keys') AS active,
              r.rolsuper, r.rolbypassrls,
              c.relowner = r.oid AS owns_table
       FROM pg_roles r JOIN pg_class c ON c.oid = 'public.tenant_keys'::regclass
       WHERE r.rolname = current_user`,
    );
    const role = z
      .object({
        active: z.literal(true),
        rolsuper: z.literal(false),
        rolbypassrls: z.literal(false),
        owns_table: z.literal(false),
      })
      .strict();
    if (roleResult.rows.length !== 1) throw new Error("Restore target role check failed");
    role.parse(roleResult.rows[0]);
    const fk = await admin.query<Record<string, unknown>>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conrelid = 'public.tenant_keys'::regclass
          AND c.confrelid = 'public.tenants'::regclass AND c.convalidated
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'tenant_id')]::smallint[]
          AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')]::smallint[]
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgconstraint = c.oid AND t.tgenabled = 'D')
      ) AS active`,
    );
    if (fk.rows.length !== 1) throw new Error("Restore target foreign key check failed");
    rlsSchema.parse(fk.rows[0]);
    const count = await admin.query<Record<string, unknown>>("SELECT count(*)::text AS count FROM public.tenant_keys");
    if (
      count.rows.length !== 1 ||
      !z
        .object({ count: z.literal("0") })
        .strict()
        .safeParse(count.rows[0]).success
    ) {
      throw new Error("Restore target already contains tenant keys");
    }
    const selection = await tools.inspectArchive(input.archive);
    if (await databasePresent(observer, name)) throw new Error("Restore staging identity is unavailable");
    creator = await admin.connect();
    creatorId = await backendIdentity(creator);
    await input.recordStage(name);
    attemptOwned = true;
    await creator.query(`CREATE DATABASE ${identifier}`);
    creator.release(true);
    creator = undefined;
    await waitForBackend(observer, creatorId);
    creatorSettled = true;
    await admin.query(`REVOKE CONNECT ON DATABASE ${identifier} FROM PUBLIC`);
    const stageUrl = new URL(input.adminUrl);
    stageUrl.pathname = `/${name}`;
    stage = new Pool({ connectionString: stageUrl.toString(), ...poolConfig });
    stage.on("error", (error: unknown) => asynchronousFailures.push(error));
    stageClient = await stage.connect();
    stageId = await backendIdentity(stageClient);
    await stageClient.query(`CREATE TABLE public.tenant_keys (
      tenant_id uuid PRIMARY KEY, wrapped_key bytea NOT NULL, wrap_nonce bytea NOT NULL,
      master_key_version smallint NOT NULL, created_at timestamptz NOT NULL
    )`);
    await tools.restoreArchive(name, input.archive, selection);
    await importStagedTenantKeys(stageClient, target, recordTarget, observer);
  } catch (error) {
    failure = { value: error };
  }
  if (creator) {
    try {
      creator.release(true);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (attemptOwned && creatorId && !creatorSettled) {
    try {
      await waitForBackend(observer, creatorId);
      creatorSettled = true;
    } catch (error) {
      cleanup.push(error);
    }
  }
  let stageClosed = stage === undefined;
  if (stageClient) {
    try {
      stageClient.release(true);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (stage) {
    try {
      await stage.end();
      if (stageId) await waitForBackend(observer, stageId);
      stageClosed = stageId !== undefined;
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (attemptOwned && creatorSettled && stageClosed) {
    let remover: import("pg").PoolClient | undefined;
    let removerId: { pid: number; backend_start: string } | undefined;
    try {
      remover = await admin.connect();
      removerId = await backendIdentity(remover);
      await remover.query(`DROP DATABASE IF EXISTS ${identifier}`);
    } catch (error) {
      cleanup.push(error);
    }
    if (remover) {
      try {
        remover.release(true);
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (removerId) {
      try {
        await waitForBackend(observer, removerId);
        stageAbsent = !(await databasePresent(observer, name));
        if (!stageAbsent) throw new Error("Restore staging database still exists");
      } catch (error) {
        cleanup.push(error);
      }
    }
  }
  for (const pool of [target, admin]) {
    try {
      await pool.end();
    } catch (error) {
      cleanup.push(error);
    }
  }
  for (const id of targetIds.values()) {
    try {
      await waitForBackend(observer, id);
    } catch (error) {
      cleanup.push(error);
    }
  }
  try {
    await observer.end();
  } catch (error) {
    cleanup.push(error);
  }
  cleanup.push(...asynchronousFailures);
  if (attemptOwned && !stageAbsent) {
    throw new RestoreStageUncertainError(name, new AggregateError(failure ? [failure.value, ...cleanup] : cleanup));
  }
  if (cleanup.length > 0)
    throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Restore cleanup failed");
  if (failure) throw failure.value;
}
