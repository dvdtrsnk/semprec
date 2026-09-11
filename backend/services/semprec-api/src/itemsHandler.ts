import type { Pool } from "pg";
import { createChokePoint, NotFoundError, ValidationError } from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireHeader, requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { toItemDetailEnvelope, toItemEnvelope } from "./adapter/itemEnvelope.js";

function jsonObjectField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`'${field}' must be a JSON object`, { field });
  }
  return value as Record<string, unknown>;
}

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

/**
 * The item endpoint family (issue #241): `POST /api/databases/:id/items`, `GET /api/items/:id`
 * (with optional `?include=path` for a server-assembled breadcrumb), and `PATCH /api/items/:id`
 * with `ifVersion`-checked optimistic concurrency. Every route is a thin mapping onto
 * `createChokePoint`'s service calls — the `Idempotency-Key` requirement, the `computed_readonly`/
 * `version_conflict`/`database_archived` rejections, and the breadcrumb walk itself all live in
 * the choke-point, not here. Soft delete/restore are #156's, not this issue's.
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
        const item = await chokePoint.findItem(id);
        if (!item) throw new NotFoundError(`Item ${id} not found`);

        const includePath = requestUrl(ctx.req.url).searchParams.get("include") === "path";
        if (!includePath) return { status: 200, body: toItemEnvelope(item) };

        const path = await chokePoint.getItemPath(id);
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
        const propertiesPatch = jsonObjectField(body.properties, "properties");
        if (!propertiesPatch) throw new ValidationError("'properties' must be a JSON object", { field: "properties" });
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
  ];
}
