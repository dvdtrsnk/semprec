import type { Pool } from "pg";
import { createChokePoint, NotFoundError } from "@semprec/data";
import type { GenericApplicationPort, Property } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { optionalHeader, requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { toItemDetailEnvelope, toItemEnvelope } from "./adapter/itemEnvelope.js";
import { toItemQueryEnvelope } from "./adapter/itemQueryEnvelope.js";
import { toRelationEnvelope } from "./adapter/relationEnvelope.js";

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

type RelationPropertyResolution = { property: Property } | { conflict: { status: number; body: unknown } };

/**
 * Resolves a relation route's `:propertyKey` path segment against the caller item's own database
 * to exactly one RELATION-typed property (issue #219) — `404 not_found` with
 * `{ resource: 'relationProperty', databaseId, propertyKey }` for no match, `409 validation_failed`
 * with `{ field: 'propertyKey', reason: 'ambiguous' }` for more than one (defensive: the
 * `UNIQUE(database_id, key)` constraint on `properties` already makes this unreachable today). The
 * ambiguous case is returned as a direct `{ status, body }` result rather than thrown, since the
 * shared code→status table fixes `validation_failed` to 400 everywhere else and this route's own
 * validator — the issue's Task calls it out as route-local, not the canonical command schema — is
 * the one place `validation_failed` answers 409 instead. Both the item lookup and the property
 * list go through the injected `GenericApplicationPort`, same as every other route in this family.
 *
 * The property list is fetched in full and filtered in memory — O(N) in the database's property
 * count — rather than an indexed key lookup. This is deliberate, not an oversight: the pre-#219
 * `chokePoint.getPropertyByKey(databaseId, key)` this replaced was O(1) but satisfies none of the
 * three requirements above — it doesn't filter by type (a non-relation property with the same key
 * would wrongly resolve), it doesn't produce this route's `{ resource: 'relationProperty', ... }`
 * 404 shape, and it returns at most one row, so it can't detect the ambiguous-match case at all. A
 * `property.getByKey` operation on `GenericApplicationPort` that did all three would be the
 * coherent fix, but #219 closes the generic-operation catalog at exactly 28 operations; adding a
 * 29th for this one call site is the scope growth
 * `docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md` rules out here. Tracked as
 * follow-up in #432.
 */
async function resolveRelationProperty(
  service: GenericApplicationPort,
  actor: ReturnType<typeof restActor>,
  callerItemId: string,
  propertyKey: string,
): Promise<RelationPropertyResolution> {
  const item = await dispatchGenericOperation(service, "item.get", actor, { itemId: callerItemId });
  const properties = await dispatchGenericOperation(service, "property.list", actor, { databaseId: item.databaseId });
  const matches = properties.filter((property) => property.key === propertyKey && property.type === "relation");
  if (matches.length === 0) {
    throw new NotFoundError(`Relation property '${propertyKey}' not found`, {
      resource: "relationProperty",
      databaseId: item.databaseId,
      propertyKey,
    });
  }
  if (matches.length > 1) {
    return {
      conflict: {
        status: 409,
        body: { error: { code: "validation_failed", details: { field: "propertyKey", reason: "ambiguous" } } },
      },
    };
  }
  return { property: matches[0]! };
}

/**
 * The item endpoint family (rebased onto the generic-operation bindings by issue #219): `POST
 * /api/databases/:id/items`, `GET /api/items/:id` (with optional `?include=path`), `PATCH
 * /api/items/:id` with `ifVersion`-checked optimistic concurrency, `DELETE /api/items/:id` and
 * `POST /api/items/:id/restore`, `POST /api/databases/:id/query`, and
 * `PUT`/`DELETE /api/items/:id/relations/:propertyKey/:targetItemId`. Every route assembles a
 * canonical command object and dispatches it through `dispatchGenericOperation` against the
 * injected `GenericApplicationPort` — no route constructs its own `createChokePoint(pool)` for an
 * operation the 28-operation catalog covers. `?include=path`'s breadcrumb chain
 * (`chokePoint.getItemPath`) is the one read this family still reaches `pool` for directly: it has
 * no corresponding generic operation, so there is no binding to rebase it onto.
 */
export function createItemRoutes(service: GenericApplicationPort, pool: Pool): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);

  return [
    {
      method: "POST",
      path: "/api/databases/:id/items",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const idempotencyKey = optionalHeader(ctx.req, "Idempotency-Key");
        const body = requireJsonObjectBody(ctx.body);
        const item = await dispatchGenericOperation(service, "item.create", restActor(ctx.identity.user.id), {
          databaseId,
          properties: body.properties ?? {},
          idempotencyKey,
        });
        return { status: 201, body: toItemEnvelope(item) };
      },
    },
    {
      method: "GET",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const includePath = requestUrl(ctx.req.url).searchParams.get("include") === "path";

        if (!includePath) {
          const item = await dispatchGenericOperation(service, "item.get", restActor(ctx.identity.user.id), {
            itemId: id,
          });
          return { status: 200, body: toItemEnvelope(item) };
        }

        // `getItemPath`'s chain already ends with `id` itself (or is empty if it doesn't exist),
        // so deriving the item from it — rather than a separate lookup — keeps both reads inside
        // `getItemPath`'s one transaction instead of two, which would otherwise let the item be
        // deleted or changed in the gap between them.
        const path = await chokePoint.getItemPath(id);
        const item = path.at(-1);
        if (!item) throw new NotFoundError(`Item ${id} not found`);
        return { status: 200, body: toItemDetailEnvelope(item, path) };
      },
    },
    {
      method: "PATCH",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const item = await dispatchGenericOperation(service, "item.patch", restActor(ctx.identity.user.id), {
          itemId: id,
          properties: body.properties,
          ifVersion: body.ifVersion,
        });
        return { status: 200, body: toItemEnvelope(item) };
      },
    },
    {
      method: "DELETE",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const item = await dispatchGenericOperation(service, "item.delete", restActor(ctx.identity.user.id), {
          itemId: id,
        });
        return { status: 200, body: toItemEnvelope(item) };
      },
    },
    {
      method: "POST",
      path: "/api/items/:id/restore",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const item = await dispatchGenericOperation(service, "item.restore", restActor(ctx.identity.user.id), {
          itemId: id,
        });
        return { status: 200, body: toItemEnvelope(item) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/query",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const result = await dispatchGenericOperation(service, "database.query", restActor(ctx.identity.user.id), {
          databaseId,
          filter: body.filter,
          sort: body.sort,
          cursor: body.cursor,
          limit: body.limit,
          inTrash: body.inTrash,
        });
        return { status: 200, body: toItemQueryEnvelope(result) };
      },
    },
    {
      method: "PUT",
      path: "/api/items/:id/relations/:propertyKey/:targetItemId",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const propertyKey = requireStringParam(ctx.params, "propertyKey");
        const targetItemId = requireStringParam(ctx.params, "targetItemId");
        const actor = restActor(ctx.identity.user.id);
        const resolution = await resolveRelationProperty(service, actor, id, propertyKey);
        if ("conflict" in resolution) return resolution.conflict;
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const edge = await dispatchGenericOperation(service, "relation.put", actor, {
          relationPropertyId: resolution.property.id,
          callerItemId: id,
          targetItemId,
          metadata: body.metadata,
        });
        return { status: 200, body: toRelationEnvelope(edge) };
      },
    },
    {
      method: "DELETE",
      path: "/api/items/:id/relations/:propertyKey/:targetItemId",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const propertyKey = requireStringParam(ctx.params, "propertyKey");
        const targetItemId = requireStringParam(ctx.params, "targetItemId");
        const actor = restActor(ctx.identity.user.id);
        const resolution = await resolveRelationProperty(service, actor, id, propertyKey);
        if ("conflict" in resolution) return resolution.conflict;
        const edge = await dispatchGenericOperation(service, "relation.delete", actor, {
          relationPropertyId: resolution.property.id,
          callerItemId: id,
          targetItemId,
        });
        return { status: 200, body: toRelationEnvelope(edge) };
      },
    },
  ];
}
