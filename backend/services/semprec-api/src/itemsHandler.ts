import type { Pool } from "pg";
import { createChokePoint, NotFoundError, ValidationError, type ChokePoint, type PropertyRow } from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireHeader, requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { toItemDetailEnvelope, toItemEnvelope } from "./adapter/itemEnvelope.js";
import { toItemQueryEnvelope } from "./adapter/itemQueryEnvelope.js";
import { toRelationEnvelope } from "./adapter/relationEnvelope.js";

function jsonObjectField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`'${field}' must be a JSON object`, { field });
  }
  return value as Record<string, unknown>;
}

function requireJsonObjectField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    throw new ValidationError(`'${field}' is required`, { field });
  }
  return jsonObjectField(value, field) as Record<string, unknown>;
}

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

/** Resolves a relation route's `:propertyKey` path segment against the caller item's own database — the choke-point's edge calls take a property id, never a key. */
async function findRelationProperty(
  chokePoint: ChokePoint,
  callerItemId: string,
  propertyKey: string,
): Promise<PropertyRow> {
  const item = await chokePoint.findItem(callerItemId);
  if (!item) throw new NotFoundError(`Item ${callerItemId} not found`);
  const property = await chokePoint.getPropertyByKey(item.databaseId, propertyKey);
  if (!property) throw new NotFoundError(`Property '${propertyKey}' not found on database ${item.databaseId}`);
  return property;
}

/**
 * The item endpoint family: `POST /api/databases/:id/items`, `GET /api/items/:id` (with optional
 * `?include=path` for a server-assembled breadcrumb), and `PATCH /api/items/:id` with
 * `ifVersion`-checked optimistic concurrency (issue #241); `DELETE /api/items/:id` and
 * `POST /api/items/:id/restore` (issue #156); `POST /api/databases/:id/query` and
 * `PUT`/`DELETE /api/items/:id/relations/:propertyKey/:targetItemId` (issue #157). Every route is
 * a thin mapping onto `createChokePoint`'s service calls — the `Idempotency-Key` requirement, the
 * `computed_readonly`/`version_conflict`/`database_archived` rejections, the typed filter/sort
 * compilation, and every relation-edge rule (direction, cardinality, ownership, endpoint validity)
 * all live in the choke-point, not here.
 */
export function createItemRoutes(pool: Pool): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);

  return [
    {
      method: "POST",
      path: "/api/databases/:id/items",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const idempotencyKey = requireHeader(ctx.req, "Idempotency-Key");
        const body = requireJsonObjectBody(ctx.body);
        const properties = jsonObjectField(body.properties, "properties") ?? {};
        const item = await chokePoint.createItem({ databaseId, properties, idempotencyKey });
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
          const item = await chokePoint.findItem(id);
          if (!item) throw new NotFoundError(`Item ${id} not found`);
          return { status: 200, body: toItemEnvelope(item) };
        }

        // `getItemPath`'s chain already ends with `id` itself (or is empty if it doesn't exist),
        // so deriving the item from it — rather than a separate `findItem` call — keeps both
        // reads inside `getItemPath`'s one transaction instead of two, which would otherwise let
        // the item be deleted or changed in the gap between them.
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
        const existing = await chokePoint.findItem(id);
        if (!existing) throw new NotFoundError(`Item ${id} not found`);

        const body = requireJsonObjectBody(ctx.body);
        const propertiesPatch = requireJsonObjectField(body.properties, "properties");
        const ifVersion = typeof body.ifVersion === "string" ? body.ifVersion : undefined;

        const item = await chokePoint.updateItem({
          databaseId: existing.databaseId,
          itemId: id,
          propertiesPatch,
          ifVersion,
        });
        return { status: 200, body: toItemEnvelope(item) };
      },
    },
    {
      method: "DELETE",
      path: "/api/items/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const existing = await chokePoint.findItemIncludingDeleted(id);
        if (!existing) throw new NotFoundError(`Item ${id} not found`);

        const item = await chokePoint.softDeleteItem(existing.databaseId, id);
        if (!item) throw new NotFoundError(`Item ${id} not found`);
        return { status: 200, body: toItemEnvelope(item) };
      },
    },
    {
      method: "POST",
      path: "/api/items/:id/restore",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const existing = await chokePoint.findItemIncludingDeleted(id);
        if (!existing) throw new NotFoundError(`Item ${id} not found`);

        const item = await chokePoint.restoreItem(existing.databaseId, id);
        if (!item) throw new NotFoundError(`Item ${id} not found`);
        return { status: 200, body: toItemEnvelope(item) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/query",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const database = await chokePoint.getDatabase(databaseId);
        if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const result = await chokePoint.queryDatabaseItems(databaseId, {
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
        const property = await findRelationProperty(chokePoint, id, propertyKey);
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const metadata = jsonObjectField(body.metadata, "metadata");
        const edge = await chokePoint.createRelation({
          relationPropertyId: property.id,
          callerItemId: id,
          targetItemId,
          metadata,
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
        const property = await findRelationProperty(chokePoint, id, propertyKey);
        const edge = await chokePoint.deleteRelation({ relationPropertyId: property.id, callerItemId: id, targetItemId });
        if (!edge) {
          throw new NotFoundError(`Relation edge not found`, {
            relationPropertyId: property.id,
            callerItemId: id,
            targetItemId,
          });
        }
        return { status: 200, body: toRelationEnvelope(edge) };
      },
    },
  ];
}
