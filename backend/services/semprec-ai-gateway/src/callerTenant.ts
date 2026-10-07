import type { IncomingMessage } from "node:http";
import { ValidationError } from "@semprec/data";
import { runInTenant } from "@semprec/shared";

const TENANT_ID_HEADER = "x-semprec-tenant-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant a trusted internal caller claims via `x-semprec-tenant-id`; `null` when the header is
 * absent (a previous-release or legacy-envelope caller, processed with no tenant scope). Call only
 * after the bearer token check. Anything that is not one canonical UUID — including a repeated
 * header, which Node joins with `, ` — is a 400. Whether the tenant exists and is active is the
 * reservation's decision, not this function's.
 */
export function readCallerTenantId(req: IncomingMessage): string | null {
  const value = req.headers[TENANT_ID_HEADER];
  if (value === undefined) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`'${TENANT_ID_HEADER}' must be a UUID`, { field: TENANT_ID_HEADER });
  }
  return value;
}

/** Runs `fn` inside the caller's tenant scope, or directly when the request carried no tenant. */
export function runForCallerTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return tenantId === null ? fn() : runInTenant(tenantId, fn);
}
