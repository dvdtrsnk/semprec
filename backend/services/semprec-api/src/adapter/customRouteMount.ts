import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { ModuleCustomRouteDefinition } from "@semprec/module-registry";
import { mountRoutes, type RouteDefinition } from "./routeTable.js";
import type { AdapterHandler } from "./adapterRoute.js";

/**
 * The shape every module custom route's `handlerExport` (issue #239's manifest field) must
 * resolve to: a factory the mount takes `pool` once at startup, getting back the actual
 * per-request `AdapterHandler` — the same `createX(pool)` shape every other handler in this
 * service already uses, just returning an adapter-shaped handler instead of building its own
 * request listener. `ModuleRegistry` resolves `handlerExport` to `unknown` (it has no reason to
 * know this service's HTTP types); this is the one place that value is cast back to this shape.
 */
export type CustomRouteHandlerFactory = (pool: Pool) => AdapterHandler;

/**
 * Resolves every active module's custom route (issue #239) into the `routeTable.ts` compiler
 * shared by every route family this adapter mounts — a custom route gets no private auth, error,
 * or path-matching logic of its own.
 */
export function mountCustomRoutes(
  pool: Pool,
  definitions: readonly ModuleCustomRouteDefinition[],
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const routes: RouteDefinition[] = definitions.map((definition) => ({
    method: definition.method,
    path: definition.path,
    handler: (definition.handler as CustomRouteHandlerFactory)(pool),
  }));
  return mountRoutes(pool, routes);
}
