import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createAdapterRequestListener, type AdapterHandler } from "./adapterRoute.js";

/**
 * A single method+path route wired through the #238 adapter — the shared shape every concrete
 * route family this service mounts compiles down to, whether it comes from a module manifest's
 * `customRoutes` (issue #239's `mountCustomRoutes`) or a generic resource family owned by this
 * service itself (issue #240's databases/properties routes). No route gets its own auth or error
 * path; both go through `createAdapterRequestListener`.
 */
export interface RouteDefinition {
  method: string;
  /** e.g. `/api/databases/:id` — a `:name` segment is captured and handed to the handler as `ctx.params.name`. */
  path: string;
  handler: AdapterHandler;
}

interface CompiledRoute {
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
 * Compiles a route table into a dispatcher: returns `true` (having already written the response)
 * for a request matching one of `routes`, `false` otherwise, so a caller can fall through to
 * whatever else it mounts.
 */
export function mountRoutes(
  pool: Pool,
  routes: readonly RouteDefinition[],
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const compiled: CompiledRoute[] = routes.map((route) => {
    const { matcher, paramNames } = compilePath(route.path);
    const listener = createAdapterRequestListener(pool, route.handler, {
      extractParams: (req) => {
        const match = pathnameOf(req).match(matcher);
        if (!match) return {};
        return Object.fromEntries(paramNames.map((name, index) => [name, match[index + 1] as string]));
      },
    });
    return { method: route.method, matcher, paramNames, listener };
  });

  return function dispatchRoute(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = pathnameOf(req);
    const route = compiled.find((candidate) => candidate.method === req.method && candidate.matcher.test(pathname));
    if (!route) return false;
    route.listener(req, res);
    return true;
  };
}
