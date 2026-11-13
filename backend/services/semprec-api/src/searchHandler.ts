import type { GenericApplicationPort } from "@semprec/shared";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import type { RouteDefinition } from "./adapter/routeTable.js";

/** A whole-number query value becomes a number; anything else is handed on as it is for the schema to refuse. */
function wholeNumberOrRaw(raw: string | null): number | string | undefined {
  if (raw === null) return undefined;
  return /^-?\d{1,15}$/.test(raw) ? Number(raw) : raw;
}

/**
 * `GET /api/search?q=&scope=&perGroupLimit=&cursor=` (issue #1842): the matches of `q` among the caller's tasks,
 * events, projects, areas, contacts, journal days and files, grouped by type (see `search`). `scope` lists group types
 * separated by commas, or repeats the parameter; the other parameters are single values. The `search` catalog
 * operation validates every value against its own schema, so a missing or empty `q`, a `q` over 200 characters, a
 * `perGroupLimit` over 50 and a `cursor` with a scope of more than one type are 400 `validation_failed` answers whose
 * messages name the field and never repeat the query. The adapter supplies authentication, the tenant scope and the
 * error mapping.
 */
export function createSearchRoutes(service: GenericApplicationPort): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/search",
      handler: async (ctx) => {
        const query = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
        const scope = query.getAll("scope").flatMap((value) => value.split(","));
        const result = await dispatchGenericOperation(service, "search", restActor(ctx.identity.user.id), {
          q: query.get("q") ?? undefined,
          scope: scope.length === 0 ? undefined : scope,
          perGroupLimit: wholeNumberOrRaw(query.get("perGroupLimit")),
          cursor: query.get("cursor") ?? undefined,
        });
        return { status: 200, body: result };
      },
    },
  ];
}
