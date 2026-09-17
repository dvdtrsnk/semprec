import type { GenericApplicationPort } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { toViewEnvelope } from "./adapter/viewEnvelope.js";
import { toViewItemEnvelope } from "./adapter/viewItemEnvelope.js";
import { toItemQueryEnvelope } from "./adapter/itemQueryEnvelope.js";

/**
 * The view endpoint family (issue #155, rebased onto the generic-operation bindings by issue
 * #219): `POST /api/databases/:id/views`, `PATCH/DELETE /api/views/:id`, `PUT/DELETE
 * /api/views/:id/items/:itemId` for curated view membership, and `POST /api/views/:id/query`
 * (issue #157). Every route assembles a canonical command object and dispatches it through
 * `dispatchGenericOperation` against the injected `GenericApplicationPort` — no route constructs
 * its own `createChokePoint(pool)`. Every write's actor is a REST human actor (`restActor`): this
 * adapter authenticates only human sessions (#34/#143); an agent-originated view write goes
 * through a different adapter entirely (see
 * `docs/adr/2026-09-10-views-are-excluded-from-the-agent-proposal-flow.md`).
 */
export function createViewRoutes(service: GenericApplicationPort): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/api/databases/:id/views",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
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
        const viewId = requireStringParam(ctx.params, "id");
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
        const viewId = requireStringParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        const view = await dispatchGenericOperation(service, "view.get", actor, { viewId });
        await dispatchGenericOperation(service, "view.delete", actor, { viewId });
        return { status: 200, body: toViewEnvelope(view) };
      },
    },
    {
      method: "PUT",
      path: "/api/views/:id/items/:itemId",
      handler: async (ctx) => {
        const viewId = requireStringParam(ctx.params, "id");
        const itemId = requireStringParam(ctx.params, "itemId");
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
      method: "DELETE",
      path: "/api/views/:id/items/:itemId",
      handler: async (ctx) => {
        const viewId = requireStringParam(ctx.params, "id");
        const itemId = requireStringParam(ctx.params, "itemId");
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
        const viewId = requireStringParam(ctx.params, "id");
        const body = ctx.body === undefined ? {} : requireJsonObjectBody(ctx.body);
        const result = await dispatchGenericOperation(service, "view.query", restActor(ctx.identity.user.id), {
          viewId,
          filter: body.filter,
          sort: body.sort,
          cursor: body.cursor,
          limit: body.limit,
          inTrash: body.inTrash,
        });
        return { status: 200, body: toItemQueryEnvelope(result) };
      },
    },
  ];
}
