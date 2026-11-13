import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import { materializeEventOccurrence } from "./materializeEventOccurrence.js";

/**
 * Duck-typed the same way `duplicateCalendarItemRouteHandler.ts` is: matches `semprec-api`'s
 * `AdapterRequestContext` structurally, with no dependency on that service's HTTP types.
 */
interface EventOccurrenceRequestContext {
  params: Record<string, string>;
  identity: { user: { id: string } };
}

/**
 * `POST /api/events/series/:seriesId/occurrences/:date` (issue gh-1843): turns one occurrence of a recurring Event
 * into an Events item, or answers with the item that already stands for it, and writes nothing else. `:seriesId` is
 * the id of the series Event and `:date` the occurrence's day `YYYY-MM-DD`. The request has no body. It answers 201
 * with the item envelope when this request created the item and 200 with the same item when it was stored before,
 * including an item in the trash, which is a cancelled occurrence and is not recreated.
 *
 * `materializeEventOccurrence` describes the transaction, the lock and the errors: a `seriesId` that is not a UUID and
 * a `date` that is not a calendar date are `400 validation_failed` on `seriesId` and `date`, a date the series does
 * not give is `400` on `date`, and an unknown series, another tenant's Event, a trashed Event and an Event that is not
 * a recurring series answer the same 404. The item is written as the requesting user.
 */
export function createMaterializeEventOccurrenceRouteHandler(pool: Pool) {
  return async (ctx: EventOccurrenceRequestContext): Promise<{ status: number; item: ItemRow }> => {
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
