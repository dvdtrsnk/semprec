import type { IncomingMessage } from "node:http";
import { ValidationError } from "@alldots/data";
import { runInTenant } from "@alldots/shared";

const TENANT_ID_HEADER = "x-alldots-tenant-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `null` when the header is absent (no tenant scope). Call only after the bearer check. Anything but
 * one canonical UUID (a repeated header is joined with `, `) is a 400. Existence and activity are
 * the reservation's decision.
 */
export function readCallerTenantId(req: IncomingMessage): string | null {
  const value = req.headers[TENANT_ID_HEADER];
  if (value === undefined) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`'${TENANT_ID_HEADER}' must be a UUID`, { field: TENANT_ID_HEADER });
  }
  return value;
}

export function runForCallerTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return tenantId === null ? fn() : runInTenant(tenantId, fn);
}
