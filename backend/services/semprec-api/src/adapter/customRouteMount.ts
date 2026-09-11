import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { ModuleCustomRouteDefinition } from "@semprec/module-registry";
import { createAdapterRequestListener, type AdapterHandler } from "./adapterRoute.js";

/**
 * The shape every module custom route's `handlerExport` (issue #239's manifest field) must
 * resolve to: a factory the mount takes `pool` once at startup, getting back the actual
 * per-request `AdapterHandler` — the same `createX(pool)` shape every other handler in this
 * service already uses, just returning an adapter-shaped handler instead of building its own
 * request listener. `ModuleRegistry` resolves `handlerExport` to `unknown` (it has no reason to
 * know this service's HTTP types); this is the one place that value is cast back to this shape.
 */
export type CustomRouteHandlerFactory = (pool: Pool) => AdapterHandler;

interface CompiledCustomRoute {
  method: string;
  matcher: RegExp;
  paramNames: string[];
  listener: (req: IncomingMessage, res: ServerResponse) => void;
}

/** Escapes every regex metacharacter in a literal path segment before it's spliced into the compiled matcher. */
function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles `/api/proposals/:id/confirm` into a matcher that captures `id`, in declaration order. */
function compilePath(path: string): { matcher: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return escapeRegExp(segment);
    })
    .join("/");
  return { matcher: new RegExp(`^${pattern}$`), paramNames };
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

/**
 * Compiles every active module's custom route (issue #239) into a request matcher wired through
 * the #238 adapter (shared auth, validation, status mapping, serialization) — a custom route gets
 * no private auth or error path of its own. Returns a dispatcher that answers `true` (having
 * already written the response) for a request matching one of these routes, `false` otherwise, so
 * a caller can fall through to whatever else it mounts.
 */
export function mountCustomRoutes(
  pool: Pool,
  definitions: readonly ModuleCustomRouteDefinition[],
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const compiled: CompiledCustomRoute[] = definitions.map((definition) => {
    const { matcher, paramNames } = compilePath(definition.path);
    const handlerFactory = definition.handler as CustomRouteHandlerFactory;
    const adapterHandler = handlerFactory(pool);
    const listener = createAdapterRequestListener(pool, adapterHandler, {
      extractParams: (req) => {
        const match = pathnameOf(req).match(matcher);
        if (!match) return {};
        return Object.fromEntries(paramNames.map((name, index) => [name, match[index + 1] as string]));
      },
    });
    return { method: definition.method, matcher, paramNames, listener };
  });

  return function dispatchCustomRoute(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = pathnameOf(req);
    const route = compiled.find((candidate) => candidate.method === req.method && candidate.matcher.test(pathname));
    if (!route) return false;
    route.listener(req, res);
    return true;
  };
}
