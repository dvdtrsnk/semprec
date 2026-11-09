import type { CollectionMetadataResolver } from "@semprec/data";
import type { Pool } from "pg";
import { createChokePoint, NotFoundError, ValidationError } from "@semprec/data";
import type { GenericApplicationPort, Property } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import {
  optionalHeader,
  requireJsonObjectBody,
  requireStringParam,
  requireUuidParam,
} from "./adapter/requestValidation.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { toItemDetailEnvelope, toItemEnvelopeWithBlobs } from "./adapter/itemEnvelope.js";
import { toItemQueryEnvelope } from "./adapter/itemQueryEnvelope.js";
import { toRelationEnvelope } from "./adapter/relationEnvelope.js";

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

function rejectCallerWriterKind(body: Record<string, unknown>): void {
  if (Object.hasOwn(body, "writerKind")) {
    throw new ValidationError("'writerKind' is server-controlled", { field: "writerKind" });
  }
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
 * lookup go through the injected `GenericApplicationPort`, same as every other route in this family;
 * the property lookup is `property.getByKey` (issue #432), an indexed `(database_id, key)` query
 * that applies the RELATION type filter in the database and returns every match, so this function
 * — not the operation — maps none/one/many onto this route's own 404/200/409 shapes.
 */
async function resolveRelationProperty(
  service: GenericApplicationPort,
  actor: ReturnType<typeof restActor>,
  callerItemId: string,
  propertyKey: string,
): Promise<RelationPropertyResolution> {
  const item = await dispatchGenericOperation(service, "item.get", actor, { itemId: callerItemId });
  const matches = await dispatchGenericOperation(service, "property.getByKey", actor, {
    databaseId: item.databaseId,
    key: propertyKey,
    type: "relation",
  });
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
 * `POST /api/items/:id/restore`, `POST /api/databases/:id/query`, `GET /api/items/:id/relations`
 * (with optional `?propertyKey=`), `PUT`/`DELETE /api/items/:id/relations/:propertyKey/:targetItemId`, and
 * `POST /api/items/:id/page/restore` (issue #1617, the page's `at` body field) and `POST /api/items/:id/page/subpages`
 * (issue #1676).
 * Every route assembles a canonical command object and dispatches it through
 * `dispatchGenericOperation` against the injected `GenericApplicationPort` — no route constructs its
 * own `createChokePoint(pool)` for an operation the 37-operation catalog covers. `?include=path`'s breadcrumb chain
 * (`chokePoint.getItemPath`) is the one read this family still reaches `pool` for directly: it has
 * no corresponding generic operation, so there is no binding to rebase it onto.
 */
export function createItemRoutes(
  service: GenericApplicationPort,
  pool: Pool,
  resolver: CollectionMetadataResolver,
): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);

  return [
    {
      method: "POST",
      path: "/api/databases/:id/items",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const idempotencyKey = optionalHeader(ctx.req, "Idempotency-Key");
        const body = requireJsonObjectBody(ctx.body);
        rejectCallerWriterKind(body);
        const item = await dispatchGenericOperation(service, "item.create", restActor(ctx.identity.user.id), {
          databaseId,
          properties: body.properties ?? {},
          idempotencyKey,
          relations: body.relations,
        });
        return { status: 201, body: await toItemEnvelopeWithBlobs(pool, item) };
      },
    },
    {
      method: "GET",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        // `include` is a comma-separated list; tokens this route does not know are ignored, as before.
        const includes = (requestUrl(ctx.req.url).searchParams.get("include") ?? "").split(",");
        const includePath = includes.includes("path");
        const includeLinks = includes.includes("links");
        const includeDerived = includes.includes("derived");
        const includeAutomation = includes.includes("automation");

        const params = requestUrl(ctx.req.url).searchParams;
        let relations: Record<string, string[]> | undefined;
        if (includes.includes("relations")) {
          const entries = [...params].filter(([key]) => key.startsWith("relations."));
          if (entries.length) {
            relations = Object.fromEntries(
              entries.map(([key, value]) => [key.slice("relations.".length), value === "" ? [] : value.split(",")]),
            );
          } else {
            const existing = await chokePoint.findItem(id);
            if (!existing) throw new NotFoundError(`Item ${id} not found`);
            relations = Object.fromEntries(
              (await chokePoint.listProperties(existing.databaseId))
                .filter((p) => p.type === "relation")
                .map((p) => [p.key, []]),
            );
          }
        }
        if (includePath) {
          const path = await chokePoint.getItemPath(id, relations === undefined ? undefined : { relations, resolver });
          const last = path.at(-1);
          if (!last) throw new NotFoundError(`Item ${id} not found`);
          const projection = includeDerived ? await chokePoint.getDerivedValuesForItems([id]) : undefined;
          const links = includeLinks
            ? ((await chokePoint.getValueLinksForItems([id], includeDerived, projection)).get(id) ?? {})
            : undefined;
          const derived = projection !== undefined ? (projection.get(id) ?? {}) : undefined;
          const automation = includeAutomation ? (await chokePoint.readAutomationForItems([id])).get(id) : undefined;
          return {
            status: 200,
            body: {
              ...toItemDetailEnvelope(last, path),
              ...(await toItemEnvelopeWithBlobs(pool, last)),
              ...(links === undefined ? {} : { links }),
              ...(derived === undefined ? {} : { derived }),
              ...(automation === undefined ? {} : { automation }),
            },
          };
        }
        const item = await dispatchGenericOperation(service, "item.get", restActor(ctx.identity.user.id), {
          itemId: id,
          include: {
            links: includeLinks,
            derived: includeDerived,
            automation: includeAutomation,
            ...(relations === undefined ? {} : { relations }),
          },
        });
        const envelope = await toItemEnvelopeWithBlobs(pool, item);
        return { status: 200, body: envelope };
      },
    },
    {
      method: "PATCH",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        rejectCallerWriterKind(body);
        const item = await dispatchGenericOperation(service, "item.patch", restActor(ctx.identity.user.id), {
          itemId: id,
          properties: body.properties,
          ifVersion: body.ifVersion,
        });
        // The explicit envelope projection omits item.patch's transaction pre-image from REST.
        return { status: 200, body: await toItemEnvelopeWithBlobs(pool, item) };
      },
    },
    {
      method: "DELETE",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        if (Object.keys(body).length !== 0) throw new ValidationError("DELETE item body must be empty");
        const item = await dispatchGenericOperation(service, "item.delete", restActor(ctx.identity.user.id), {
          itemId: id,
        });
        return { status: 200, body: await toItemEnvelopeWithBlobs(pool, item) };
      },
    },
    {
      method: "POST",
      path: "/api/items/:id/restore",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const item = await dispatchGenericOperation(service, "item.restore", restActor(ctx.identity.user.id), {
          itemId: id,
        });
        return { status: 200, body: await toItemEnvelopeWithBlobs(pool, item) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/query",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const result = await dispatchGenericOperation(service, "database.query", restActor(ctx.identity.user.id), {
          databaseId,
          include: body.include,
          filter: body.filter,
          sort: body.sort,
          cursor: body.cursor,
          limit: body.limit,
          inTrash: body.inTrash,
          includeCount: body.includeCount,
        });
        return { status: 200, body: await toItemQueryEnvelope(pool, result) };
      },
    },
    {
      method: "POST",
      path: "/api/items/:id/links/:propertyKey/unlink",
      handler: async (ctx) => {
        const input = {
          itemId: requireUuidParam(ctx.params, "id"),
          propertyKey: requireStringParam(ctx.params, "propertyKey"),
        };
        return {
          status: 200,
          body: await dispatchGenericOperation(service, "link.unlink", restActor(ctx.identity.user.id), input),
        };
      },
    },
    {
      method: "POST",
      path: "/api/items/:id/links/:propertyKey/relink",
      handler: async (ctx) => {
        const input = {
          itemId: requireUuidParam(ctx.params, "id"),
          propertyKey: requireStringParam(ctx.params, "propertyKey"),
        };
        return {
          status: 200,
          body: await dispatchGenericOperation(service, "link.relink", restActor(ctx.identity.user.id), input),
        };
      },
    },
    {
      method: "GET",
      path: "/api/items/:id/relations",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        // `?propertyKey=` narrows the list to one relation property, resolved exactly as the write routes resolve it.
        const propertyKey = requestUrl(ctx.req.url).searchParams.get("propertyKey");
        let relationPropertyId: string | undefined;
        if (propertyKey !== null) {
          const resolution = await resolveRelationProperty(service, actor, id, propertyKey);
          if ("conflict" in resolution) return resolution.conflict;
          relationPropertyId = resolution.property.id;
        }
        const relations = await dispatchGenericOperation(service, "relation.list", actor, {
          itemId: id,
          relationPropertyId,
        });
        return { status: 200, body: { relations } };
      },
    },
    {
      method: "PUT",
      path: "/api/items/:id/relations/:propertyKey",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const propertyKey = requireStringParam(ctx.params, "propertyKey");
        const actor = restActor(ctx.identity.user.id);
        const resolution = await resolveRelationProperty(service, actor, id, propertyKey);
        if ("conflict" in resolution) return resolution.conflict;
        const body = requireJsonObjectBody(ctx.body);
        if (Object.keys(body).some((key) => key !== "targetItemId"))
          throw new ValidationError("Unexpected relation set field", { field: "targetItemId" });
        try {
          const edge = await dispatchGenericOperation(service, "relation.set", actor, {
            relationPropertyId: resolution.property.id,
            callerItemId: id,
            targetItemId: body.targetItemId,
          });
          return { status: 200, body: edge ? toRelationEnvelope(edge) : { deleted: true } };
        } catch (error) {
          if (error instanceof ValidationError && error.message === "Relation property is not single-valued")
            throw new ValidationError(error.message, { field: "propertyKey" });
          throw error;
        }
      },
    },
    {
      method: "PUT",
      path: "/api/items/:id/relations/:propertyKey/:targetItemId",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const propertyKey = requireStringParam(ctx.params, "propertyKey");
        const targetItemId = requireUuidParam(ctx.params, "targetItemId");
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
        const id = requireUuidParam(ctx.params, "id");
        const propertyKey = requireStringParam(ctx.params, "propertyKey");
        const targetItemId = requireUuidParam(ctx.params, "targetItemId");
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
    {
      method: "PUT",
      path: "/api/items/:id/page",
      handler: async (ctx) => ({
        status: 200,
        body: await dispatchGenericOperation(service, "page.ensure", restActor(ctx.identity.user.id), {
          itemId: requireUuidParam(ctx.params, "id"),
        }),
      }),
    },
    {
      method: "GET",
      path: "/api/items/:id/page",
      handler: async (ctx) => {
        const params = requestUrl(ctx.req.url).searchParams;
        const rawLimit = params.get("limit");
        if (rawLimit !== null && !/^\d+$/.test(rawLimit))
          throw new ValidationError("Invalid page limit", { field: "limit" });
        const result = await dispatchGenericOperation(service, "page.get", restActor(ctx.identity.user.id), {
          itemId: requireUuidParam(ctx.params, "id"),
          format: params.get("format") ?? "summary",
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        });
        return { status: 200, body: result };
      },
    },
    {
      // The path item is the parent (ADR 2026-10-28-page-operation-family); a Journal period parent is reachable
      // through the catalog (MCP, agent tools), not here, because a period without an entry has no item id to name.
      method: "POST",
      path: "/api/items/:id/page/subpages",
      handler: async (ctx) => {
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const unexpected = Object.keys(body).find((key) => key !== "afterBlockId" && key !== "title");
        if (unexpected !== undefined) throw new ValidationError("Unexpected subpage field", { field: unexpected });
        const created = await dispatchGenericOperation(service, "page.createSubpage", restActor(ctx.identity.user.id), {
          parent: { itemId: requireUuidParam(ctx.params, "id") },
          afterBlockId: body.afterBlockId,
          title: body.title,
        });
        return { status: 201, body: created };
      },
    },
    {
      method: "POST",
      path: "/api/items/:id/page/restore",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const restored = await dispatchGenericOperation(
          service,
          "page.restoreVersion",
          restActor(ctx.identity.user.id),
          {
            itemId: id,
            at: body.at,
          },
        );
        return { status: 200, body: restored };
      },
    },
  ];
}
