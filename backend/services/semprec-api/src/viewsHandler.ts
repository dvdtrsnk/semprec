import type { Pool } from "pg";
import { createChokePoint, NotFoundError, ValidationError, type Actor } from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringField, requireStringParam } from "./adapter/requestValidation.js";
import { toViewEnvelope } from "./adapter/viewEnvelope.js";
import { toViewItemEnvelope } from "./adapter/viewItemEnvelope.js";

const USER_ACTOR: Actor = { type: "user" };

function optionalConfigField(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof body.config === "object" && body.config !== null && !Array.isArray(body.config)
    ? (body.config as Record<string, unknown>)
    : undefined;
}

/** Postgres's `integer` column backing `view_items.position` holds at most this value. */
const POSTGRES_INT4_MAX = 2147483647;

/** `view_items.position` is a non-negative Postgres `integer`; an out-of-range value must fail as 400, not surface as a raw DB error. */
function optionalPositionField(body: Record<string, unknown>): number | undefined {
  if (body.position === undefined) return undefined;
  const { position } = body;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position > POSTGRES_INT4_MAX) {
    throw new ValidationError(`'position' must be a non-negative integer not exceeding ${POSTGRES_INT4_MAX}`, {
      field: "position",
    });
  }
  return position;
}

/**
 * The view endpoint family (issue #155): `POST /api/databases/:id/views`, `PATCH/DELETE
 * /api/views/:id`, and `PUT/DELETE /api/views/:id/items/:itemId` for curated view membership.
 * Every route is a thin mapping onto `createChokePoint`'s service calls — no business rule is
 * reimplemented here, and no successful mutation returns 204. Every write's `actor` is `{ type:
 * 'user' }`: this REST adapter authenticates only human sessions (#34/#143); an agent-originated
 * view write goes through a different adapter entirely (see
 * `docs/adr/2026-09-10-views-are-excluded-from-the-agent-proposal-flow.md`).
 */
export function createViewRoutes(pool: Pool): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);

  return [
    {
      method: "POST",
      path: "/api/databases/:id/views",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const type = requireStringField(body, "type");
        const name = requireStringField(body, "name");
        const config = optionalConfigField(body);
        const isDefault = typeof body.isDefault === "boolean" ? body.isDefault : undefined;
        const view = await chokePoint.createView({ databaseId, type, name, config, isDefault }, USER_ACTOR);
        return { status: 201, body: toViewEnvelope(view) };
      },
    },
    {
      method: "PATCH",
      path: "/api/views/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const name = typeof body.name === "string" ? body.name : undefined;
        const config = optionalConfigField(body);
        const isDefault = typeof body.isDefault === "boolean" ? body.isDefault : undefined;
        const view = await chokePoint.patchView({ id, actor: USER_ACTOR, name, config, isDefault });
        return { status: 200, body: toViewEnvelope(view) };
      },
    },
    {
      method: "DELETE",
      path: "/api/views/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const view = await chokePoint.getView(id);
        if (!view) throw new NotFoundError(`View ${id} not found`);
        await chokePoint.deleteView({ id, actor: USER_ACTOR });
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
        const position = optionalPositionField(body);
        const viewItem = await chokePoint.addViewItem({ viewId, itemId, position, actor: USER_ACTOR });
        return { status: 200, body: toViewItemEnvelope(viewItem) };
      },
    },
    {
      method: "DELETE",
      path: "/api/views/:id/items/:itemId",
      handler: async (ctx) => {
        const viewId = requireStringParam(ctx.params, "id");
        const itemId = requireStringParam(ctx.params, "itemId");
        const view = await chokePoint.getView(viewId);
        if (!view) throw new NotFoundError(`View ${viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", {
            field: "viewId",
          });
        }
        const members = await chokePoint.listViewItems(viewId);
        const target = members.find((member) => member.itemId === itemId);
        if (!target) throw new NotFoundError(`Item ${itemId} is not a member of view ${viewId}`);
        await chokePoint.removeViewItem({ viewId, itemId, actor: USER_ACTOR });
        return { status: 200, body: toViewItemEnvelope(target) };
      },
    },
  ];
}
