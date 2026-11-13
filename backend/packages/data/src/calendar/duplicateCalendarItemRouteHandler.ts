import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { duplicateCalendarItem } from "./duplicateCalendarItem.js";

/**
 * Duck-typed the same way `eventParticipantsRouteHandlers.ts` is: matches `semprec-api`'s
 * `AdapterRequestContext` structurally, with no dependency on that service's HTTP types.
 */
interface DuplicateCalendarItemRequestContext {
  req: { headers: Record<string, string | string[] | undefined> };
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

const itemIdSchema = z.uuid();

/** The longest `Idempotency-Key` the route takes; a longer one is refused instead of stored. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const bodySchema = z
  .object({
    date: z.string(),
    timeFrom: z.string().optional(),
    timeTo: z.string().optional(),
    endDate: z.string().optional(),
  })
  .strict();

/** The `Idempotency-Key` header, or `undefined` when the request has none or an empty one. */
function readIdempotencyKey(headers: DuplicateCalendarItemRequestContext["req"]["headers"]): string | undefined {
  const value = headers["idempotency-key"];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError(
      `'Idempotency-Key' must be one header of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      {
        field: "Idempotency-Key",
      },
    );
  }
  return value;
}

/**
 * `POST /api/calendar/items/:id/duplicate` (issue gh-1796): copies an Event or a Task to a new date and answers 201
 * with the item envelope of the copy. The body is `{ date, timeFrom?, timeTo?, endDate? }`, each value a string; the
 * copy's date and times are judged by the write rules of its database (a `timeTo` of `24:15` is `validation_failed`
 * on `timeTo` and nothing is stored). An optional `Idempotency-Key` header makes a repeated request answer 201 with
 * the copy the first one created and copy nothing again. `duplicateCalendarItem` describes the copy and the
 * transaction it runs in.
 *
 * An `id` that is not a UUID, a body that is not an object of that shape and an `Idempotency-Key` of more than one
 * header or more than 255 characters are `400 validation_failed` on the field, before the transaction starts. An
 * unknown id, another tenant's item, a trashed item and an item that is neither an Event nor a Task answer the same 404.
 */
export function createDuplicateCalendarItemRouteHandler(pool: Pool) {
  return async (ctx: DuplicateCalendarItemRequestContext): Promise<{ status: number; item: ItemRow }> => {
    const id = itemIdSchema.safeParse(ctx.params.id);
    if (!id.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const body = bodySchema.safeParse(ctx.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const field = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      throw new ValidationError("The body must be { date, timeFrom?, timeTo?, endDate? }, each value a string", {
        field: typeof field === "string" ? field : "body",
      });
    }
    const idempotencyKey = readIdempotencyKey(ctx.req.headers);
    const item = await withTransaction(pool, (client) =>
      duplicateCalendarItem(client, {
        itemId: id.data,
        ...body.data,
        idempotencyKey,
        actor: { userId: ctx.identity.user.id },
      }),
    );
    return { status: 201, item };
  };
}
