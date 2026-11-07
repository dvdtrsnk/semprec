import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { advanceTaskRecurrenceWithClient, type AdvanceTaskRecurrenceInput } from "./advanceTaskRecurrenceWithClient.js";

export type { AdvanceTaskRecurrenceInput };

/**
 * Completes a recurring task occurrence and creates the next occurrence of its series
 * (`advanceTaskRecurrenceWithClient`, issues #1605 and #1670). Returns `null` (no-op) when the item
 * belongs to no active series or the next date already has an occurrence.
 *
 * Opens its own transaction around `advanceTaskRecurrenceWithClient` plus the `done` write.
 * That `done` write re-enters the choke point's Tasks hook (`updateItemWithClient`), which
 * finds the next date already occupied by the occurrence created here and creates nothing.
 */
export async function advanceTaskRecurrence(pool: Pool, input: AdvanceTaskRecurrenceInput): Promise<ItemRow | null> {
  return withTransaction(pool, async (client) => {
    const next = await advanceTaskRecurrenceWithClient(client, input, createItemWithClient);
    if (next === null) return null;
    await updateItemWithClient(client, {
      databaseId: input.databaseId,
      itemId: input.itemId,
      propertiesPatch: { status: "done" },
    });
    return next;
  });
}
