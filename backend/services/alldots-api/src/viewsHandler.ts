import type { Pool } from "pg";
import type { GenericApplicationPort } from "@alldots/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { optionalIntegerQueryParam, requireJsonObjectBody, requireUuidParam } from "./adapter/requestValidation.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { toViewEnvelope } from "./adapter/viewEnvelope.js";
import { toViewItemEnvelope } from "./adapter/viewItemEnvelope.js";
import { toItemQueryEnvelope } from "./adapter/itemQueryEnvelope.js";

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

/**
 * Every route dispatches through `dispatchGenericOperation` against the injected
 * `GenericApplicationPort`. `PUT` on a view item adds or repositions, `PATCH` reorders an existing
 * member. `view.list` has a global catalog, so `GET /api/views` takes no database segment. Every
 * write's actor is a REST human actor; agents do not write views through this adapter.
 */
export function createViewRoutes(service: GenericApplicationPort, pool: Pool): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/views",
      handler: async (ctx) => {
        const query = requestUrl(ctx.req.url).searchParams;
        const page = await dispatchGenericOperation(service, "view.list", restActor(ctx.identity.user.id), {
          cursor: query.get("cursor") ?? undefined,
          limit: optionalIntegerQueryParam(query, "limit"),
        });
        return { status: 200, body: { views: page.items.map(toViewEnvelope), nextCursor: page.nextCursor } };
      },
    },
    {
      method: "GET",
      path: "/api/views/:id",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const view = await dispatchGenericOperation(service, "view.get", restActor(ctx.identity.user.id), { viewId });
        return { status: 200, body: toViewEnvelope(view) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/views",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const view = await dispatchGenericOperation(service, "view.create", restActor(ctx.identity.user.id), {
          databaseId,
          type: body.type,
          name: body.name,
          config: body.config,
          isDefault: body.isDefault,
        });
        return { status: 201, body: toViewEnvelope(view) };
      },
    },
    {
      method: "PATCH",
      path: "/api/views/:id",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.config !== undefined) patch.config = body.config;
        if (body.isDefault !== undefined) patch.isDefault = body.isDefault;
        const view = await dispatchGenericOperation(service, "view.patch", restActor(ctx.identity.user.id), {
          viewId,
          patch,
        });
        return { status: 200, body: toViewEnvelope(view) };
      },
    },
    {
      method: "DELETE",
      path: "/api/views/:id",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        // The deleted row comes back from `view.delete` itself: exactly the state the deletion
        // transaction saw.
        const view = await dispatchGenericOperation(service, "view.delete", actor, { viewId });
        return { status: 200, body: toViewEnvelope(view) };
      },
    },
    {
      method: "PUT",
      path: "/api/views/:id/items/:itemId",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const itemId = requireUuidParam(ctx.params, "itemId");
        const body = requireJsonObjectBody(ctx.body);
        const viewItem = await dispatchGenericOperation(service, "viewItem.add", restActor(ctx.identity.user.id), {
          viewId,
          itemId,
          position: body.position,
        });
        return { status: 200, body: toViewItemEnvelope(viewItem) };
      },
    },
    {
      method: "PATCH",
      path: "/api/views/:id/items/:itemId",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const itemId = requireUuidParam(ctx.params, "itemId");
        const body = requireJsonObjectBody(ctx.body);
        const viewItem = await dispatchGenericOperation(service, "viewItem.reorder", restActor(ctx.identity.user.id), {
          viewId,
          itemId,
          position: body.position,
        });
        return { status: 200, body: toViewItemEnvelope(viewItem) };
      },
    },
    {
      method: "DELETE",
      path: "/api/views/:id/items/:itemId",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const itemId = requireUuidParam(ctx.params, "itemId");
        const result = await dispatchGenericOperation(service, "viewItem.remove", restActor(ctx.identity.user.id), {
          viewId,
          itemId,
        });
        return { status: 200, body: result };
      },
    },
    {
      method: "POST",
      path: "/api/views/:id/query",
      handler: async (ctx) => {
        const viewId = requireUuidParam(ctx.params, "id");
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const result = await dispatchGenericOperation(service, "view.query", restActor(ctx.identity.user.id), {
          viewId,
          include: body.include,
          filter: body.filter,
          sort: body.sort,
          cursor: body.cursor,
          limit: body.limit,
          inTrash: body.inTrash,
          includeCount: body.includeCount,
          q: body.q,
        });
        return { status: 200, body: await toItemQueryEnvelope(pool, result) };
      },
    },
  ];
}
