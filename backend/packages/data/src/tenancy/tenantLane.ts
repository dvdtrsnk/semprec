import { currentTenantScope } from "@alldots/shared";

/**
 * `<lane>:<tenantId>` inside a tenant scope, `undefined` otherwise. Derived from the enqueuing scope only,
 * never from payload data.
 */
export function tenantLane(lane: string): string | undefined {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? `${lane}:${scope.tenantId}` : undefined;
}
