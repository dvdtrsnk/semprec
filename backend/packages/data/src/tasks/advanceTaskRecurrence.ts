import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { advanceTaskRecurrenceWithClient, type AdvanceTaskRecurrenceInput } from "./advanceTaskRecurrenceWithClient.js";

export type { AdvanceTaskRecurrenceInput };

/**
 * The rolling model (issue #24): at any moment only one open instance of a recurring task
 * exists. Completing it (marking it 'done') creates the next instance and carries forward
 * its name/time/notification/persistent properties and every relation edge it participated
 * in (e.g. its Projects link) — not just the recurrence rule itself. Returns `null` (no-op)
 * when the completed item has no active recurrence, which is the common case.
 *
 * Opens its own transaction around `advanceTaskRecurrenceWithClient` plus the `done` write.
 * That `done` write re-enters the choke point's Tasks hook (`updateItemWithClient`), which
 * finds the recurrence already deactivated in this same transaction and no-ops.
 */
export async function advanceTaskRecurrence(pool: Pool, input: AdvanceTaskRecurrenceInput): Promise<ItemRow | null> {
  return withTransaction(pool, async (client) => {
    const next = await advanceTaskRecurrenceWithClient(client, input, createItemWithClient);
    await updateItemWithClient(client, {
      databaseId: input.databaseId,
      itemId: input.itemId,
      propertiesPatch: { status: "done" },
    });
    return next;
  });
}
