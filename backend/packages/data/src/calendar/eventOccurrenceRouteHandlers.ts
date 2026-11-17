import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import { materializeEventOccurrence } from "./materializeEventOccurrence.js";
import type { RouteParams, RouteUser } from "../customRoute.js";

/**
 * `POST /api/events/series/:seriesId/occurrences/:date`: materializes one occurrence. 201 when this request
 * created the item, 200 when it existed, including a trashed one (a cancelled occurrence, not recreated). See
 * `materializeEventOccurrence` for the transaction, lock and errors.
 */
export function createMaterializeEventOccurrenceRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteUser): Promise<{ status: number; item: ItemRow }> => {
    const userId = ctx.identity.user.id;
    const { item, created } = await withTransaction(pool, (client) =>
      materializeEventOccurrence(client, {
        seriesId: ctx.params.seriesId ?? "",
        occurrenceDate: ctx.params.date ?? "",
        options: { writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
      }),
    );
    return { status: created ? 201 : 200, item };
  };
}
