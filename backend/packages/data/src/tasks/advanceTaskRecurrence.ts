import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { advanceTaskRecurrenceWithClient, type AdvanceTaskRecurrenceInput } from "./advanceTaskRecurrenceWithClient.js";

export type { AdvanceTaskRecurrenceInput };

/**
 * Completes a recurring occurrence and creates the next one in its own transaction. Returns `null` when there is
 * no active series, the item is not the current occurrence, or the next date already has one. The `done` write
 * re-enters the Tasks hook, which finds the series already moved and creates nothing.
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
