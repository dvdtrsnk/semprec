import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createAdapterRequestListener, type AdapterHandler } from "./adapterRoute.js";

/**
 * Every route family compiles down to this, whether from a module manifest's `customRoutes` or a
 * family owned by this service; all go through `createAdapterRequestListener`.
 */
export interface RouteDefinition {
  method: string;
  /** A `:name` segment is captured as `ctx.params.name`. */
  path: string;
  handler: AdapterHandler;
  /**
   * Members get 403 `admin_required` and the handler runs in system scope. Required for every
   * `/api/admin/` path.
   */
  admin?: true;
}

interface CompiledRoute {
  method: string;
  matcher: RegExp;
  paramNames: string[];
  listener: (req: IncomingMessage, res: ServerResponse) => void;
}

function escapeRegExp(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Captures params in declaration order. */
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
 * Returns `true` (response already written) for a matching request, `false` otherwise so the caller
 * can fall through.
 */
export function mountRoutes(
  pool: Pool,
  routes: readonly RouteDefinition[],
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const compiled: CompiledRoute[] = routes.map((route) => {
    if (route.path.startsWith("/api/admin/") && route.admin !== true) {
      throw new Error(`Route ${route.method} ${route.path} is under /api/admin/ but is not flagged admin: true`);
    }
    const { matcher, paramNames } = compilePath(route.path);
    const listener = createAdapterRequestListener(pool, route.handler, {
      admin: route.admin === true,
      extractParams: (req) => {
        // dispatchRoute already tested this pattern.
        const match = pathnameOf(req).match(matcher)!;
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
