import type { GenericApplicationPort } from "@semprec/shared";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import type { RouteDefinition } from "./adapter/routeTable.js";

/** Anything else is handed on for the schema to refuse. */
function wholeNumberOrRaw(raw: string | null): number | string | undefined {
  if (raw === null) return undefined;
  return /^-?\d{1,15}$/.test(raw) ? Number(raw) : raw;
}

/**
 * Matches among the caller's tasks, events, projects, contacts, journal days and files,
 * grouped by type. `scope` is comma-separated or repeated. The `search` operation's schema
 * validates every value, so invalid input is 400 `validation_failed` naming the field and never
 * repeating the query.
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
