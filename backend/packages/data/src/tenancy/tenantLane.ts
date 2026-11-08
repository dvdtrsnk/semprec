import { currentTenantScope } from "@semprec/shared";

/**
 * The per-tenant queue name for a lane: `<lane>:<tenantId>` inside a tenant scope, `undefined` in a
 * system scope or with no scope (the job then keeps today's lane naming). Derived from the enqueuing
 * scope only, never from payload data.
 */
export function tenantLane(lane: string): string | undefined {
  const scope = currentTenantScope();
  return scope?.kind === "tenant" ? `${lane}:${scope.tenantId}` : undefined;
}
