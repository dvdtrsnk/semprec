import { generateDataKey, resolveMasterKeyFromEnv, unwrapDataKey, wrapDataKey } from "@semprec/credentials";
import type { Queryable } from "../db/pool.js";

export interface TenantDataKey {
  tenantId: string;
  dataKey: Buffer;
}

/** The master key version new tenant keys are wrapped under. */
const CURRENT_MASTER_KEY_VERSION = 1;

interface TenantKeyRow {
  tenant_id: string;
  wrapped_key: Buffer;
  wrap_nonce: Buffer;
  master_key_version: number;
}

/**
 * The current tenant's data key, or null when it has none yet. The explicit `app_tenant_default()`
 * filter sits on top of row-level security so a superuser connection cannot pick another tenant's
 * row either. An unwrap failure propagates.
 */
export async function getTenantDataKey(client: Queryable): Promise<TenantDataKey | null> {
  const { rows } = await client.query<TenantKeyRow>(
    `SELECT tenant_id, wrapped_key, wrap_nonce, master_key_version
       FROM tenant_keys WHERE tenant_id = app_tenant_default()`,
  );
  const row = rows[0];
  if (!row) return null;
  const masterKey = resolveMasterKeyFromEnv(row.master_key_version);
  const dataKey = await unwrapDataKey({ ciphertext: row.wrapped_key, nonce: row.wrap_nonce }, masterKey, row.tenant_id);
  return { tenantId: row.tenant_id, dataKey };
}

/**
 * The current tenant's data key, creating it on first use. Concurrent creators converge on one
 * key: the insert is `ON CONFLICT DO NOTHING` and the row is read back afterwards. Works on a pool
 * and inside a transaction.
 */
export async function getOrCreateTenantDataKey(client: Queryable): Promise<TenantDataKey> {
  const existing = await getTenantDataKey(client);
  if (existing) return existing;

  const { rows: scopeRows } = await client.query<{ tenant_id: string | null }>(
    "SELECT app_tenant_default() AS tenant_id",
  );
  const tenantId = scopeRows[0]?.tenant_id;
  if (!tenantId) {
    throw new Error("No tenant scope: refusing to create a tenant data key");
  }

  const masterKey = resolveMasterKeyFromEnv(CURRENT_MASTER_KEY_VERSION);
  const wrapped = await wrapDataKey(await generateDataKey(), masterKey, tenantId);
  await client.query(
    `INSERT INTO tenant_keys (wrapped_key, wrap_nonce, master_key_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [wrapped.ciphertext, wrapped.nonce, CURRENT_MASTER_KEY_VERSION],
  );

  const created = await getTenantDataKey(client);
  if (!created) {
    throw new Error("Tenant data key missing after insert");
  }
  return created;
}
