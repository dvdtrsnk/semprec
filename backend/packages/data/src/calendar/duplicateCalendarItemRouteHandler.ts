import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { duplicateCalendarItem } from "./duplicateCalendarItem.js";

/** Matches `semprec-api`'s `AdapterRequestContext` structurally, without depending on its HTTP types. */
interface DuplicateCalendarItemRequestContext {
  req: { headers: Record<string, string | string[] | undefined> };
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

const itemIdSchema = z.uuid();

/** A longer key is refused instead of stored. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const bodySchema = z
  .object({
    date: z.string(),
    timeFrom: z.string().optional(),
    timeTo: z.string().optional(),
    endDate: z.string().optional(),
  })
  .strict();

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
 * `POST /api/calendar/items/:id/duplicate` answers 201 with the copy's item envelope. A repeated
 * `Idempotency-Key` answers with the first request's copy. Shape errors (non-UUID id, bad body, a repeated or
 * over-long key) are 400 before the transaction; any not-found case answers the same 404.
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
