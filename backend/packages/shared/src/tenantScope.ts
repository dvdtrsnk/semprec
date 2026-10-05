import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger, type Logger } from "./logger.js";

/**
 * The tenant a piece of work runs for. `system` is work that belongs to no tenant (startup,
 * listeners, schedulers); it reads as no `app.tenant_id` in Postgres. See
 * `docs/adr/2026-10-05-tenant-scope-propagation.md`.
 */
export type TenantScope =
  { readonly kind: "tenant"; readonly tenantId: string } | { readonly kind: "system"; readonly reason: string };

/** Entering a scope that would leave one tenant for another, or a system scope from inside a tenant. */
export class TenantScopeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeConflictError";
  }
}

/** A database access ran outside any scope while `SEMPREC_TENANT_SCOPE=strict`. */
export class TenantScopeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeMissingError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Distinct stacks remembered by warn mode; once full, every further novel stack still logs. */
const MAX_REMEMBERED_STACKS = 1_000;

const tenantScopeStorage = new AsyncLocalStorage<TenantScope>();
const warnedStacks = new Set<string>();

// Created on first use: `logger.ts` is allowed to import this module, so a top-level
// `createLogger` call here would run before `logger.ts` has finished evaluating.
let scopeLogger: Logger | undefined;
function getScopeLogger(): Logger {
  scopeLogger ??= createLogger("tenant-scope");
  return scopeLogger;
}

/** The active scope, or `undefined` outside any `runInTenant`/`runAsSystem` call. */
export function currentTenantScope(): TenantScope | undefined {
  return tenantScopeStorage.getStore();
}

/**
 * Runs `fn` for `tenantId`. From no scope or a system scope it enters the tenant; inside the same
 * tenant it just runs `fn`; inside a different tenant it throws `TenantScopeConflictError`.
 * `tenantId` must be a canonical UUID (it is stored lower-cased) or `TypeError` is thrown and `fn`
 * is not called.
 */
export function runInTenant<T>(tenantId: string, fn: () => T): T {
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    throw new TypeError("runInTenant requires a canonical UUID tenant id");
  }
  const normalized = tenantId.toLowerCase();
  const current = tenantScopeStorage.getStore();
  if (current?.kind === "tenant") {
    if (current.tenantId === normalized) return fn();
    throw new TenantScopeConflictError(`Cannot enter tenant ${normalized} from inside tenant ${current.tenantId}`);
  }
  return tenantScopeStorage.run({ kind: "tenant", tenantId: normalized }, fn);
}

/**
 * Runs `fn` as tenant-less system work. From no scope or a system scope it enters `{ system, reason }`
 * (the inner reason wins); inside a tenant it throws `TenantScopeConflictError`, because a system
 * scope would otherwise be a way to leave one tenant and enter another.
 */
export function runAsSystem<T>(reason: string, fn: () => T): T {
  assertReason(reason, "runAsSystem");
  const current = tenantScopeStorage.getStore();
  if (current?.kind === "tenant") {
    throw new TenantScopeConflictError(
      `Cannot enter a system scope ("${reason}") from inside tenant ${current.tenantId}`,
    );
  }
  return tenantScopeStorage.run({ kind: "system", reason }, fn);
}

/**
 * Runs `fn` in a fresh system scope whatever the current scope is. Its only permitted use is opening
 * shared, long-lived I/O resources (a pooled database connection) whose event callbacks run in the
 * async context that opened them and must never inherit one caller's tenant. It never runs work.
 */
export function runDetachedAsSystem<T>(reason: string, fn: () => T): T {
  assertReason(reason, "runDetachedAsSystem");
  return tenantScopeStorage.run({ kind: "system", reason }, fn);
}

/**
 * Called by every database access site. With a scope active it returns it. Without one the mode in
 * `SEMPREC_TENANT_SCOPE` (read on every call) decides: unset/empty/`warn` logs `tenant_scope_missing`
 * once per distinct stack and returns `undefined`; `strict` throws `TenantScopeMissingError`; any
 * other value throws an `Error`.
 */
export function enforceTenantScope(site: string): TenantScope | undefined {
  const scope = tenantScopeStorage.getStore();
  if (scope) return scope;

  const mode = process.env.SEMPREC_TENANT_SCOPE;
  if (mode === "strict") {
    throw new TenantScopeMissingError(`No tenant scope is active at ${site}`);
  }
  if (mode !== undefined && mode !== "" && mode !== "warn") {
    throw new Error(`Unknown SEMPREC_TENANT_SCOPE value "${mode}"; expected "warn" or "strict"`);
  }

  const stack = new Error().stack ?? "";
  if (!warnedStacks.has(stack)) {
    if (warnedStacks.size < MAX_REMEMBERED_STACKS) warnedStacks.add(stack);
    getScopeLogger().warn({ site, stack }, "tenant_scope_missing");
  }
  return undefined;
}

function assertReason(reason: string, fnName: string): void {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new TypeError(`${fnName} requires a non-empty reason`);
  }
}
