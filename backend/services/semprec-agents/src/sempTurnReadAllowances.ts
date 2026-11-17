import type { Pool, PoolClient } from "pg";
import { allowItemsForTurn, clearForRun, listSleepNightReadItemIds, withTransaction } from "@semprec/data";
import { labeledSempMessageRefSchema, sempMessageRefSchema, type SempMessageRef } from "@semprec/shared";

// Items a user attached to a message are readable by the agent for that turn only, without a database grant.
// An attached sleep night opens the items it is computed from.

/** The refs of a stored message context that parse against the stored-ref schemas; an entry that does not names nothing. */
function parseStoredRefs(stored: unknown): SempMessageRef[] {
  if (!Array.isArray(stored)) return [];
  const entries: unknown[] = stored;
  return entries.flatMap((entry) => {
    const labeled = labeledSempMessageRefSchema.safeParse(entry);
    const ref = labeled.success ? labeled.data : sempMessageRefSchema.safeParse(entry).data;
    return ref ? [ref] : [];
  });
}

/** Only `item`, `block` and `transcriptSegment` refs open an item; `sleepNight` is resolved by `openTurnReadAllowances`. */
export function readAllowedItemIds(stored: unknown): string[] {
  const ids = new Set<string>();
  for (const ref of parseStoredRefs(stored)) {
    if (ref.kind === "item" || ref.kind === "block" || ref.kind === "transcriptSegment") {
      ids.add(ref.itemId.toLowerCase());
    }
  }
  return [...ids];
}

/** The nights of the `sleepNight` refs of a stored message context, each once. */
export function readAttachedSleepNights(stored: unknown): string[] {
  const nights = new Set<string>();
  for (const ref of parseStoredRefs(stored)) if (ref.kind === "sleepNight") nights.add(ref.night);
  return [...nights];
}

/**
 * Clears rows a crashed earlier turn left, then allows this message's refs. Ids come from the
 * persisted refs, never from a tool argument.
 */
export async function openTurnReadAllowances(client: PoolClient, runId: string, stored: unknown): Promise<void> {
  await clearForRun(client, runId);
  const sleepItemIds = await listSleepNightReadItemIds(client, readAttachedSleepNights(stored));
  await allowItemsForTurn(client, runId, [...new Set([...readAllowedItemIds(stored), ...sleepItemIds])]);
}

/** Ends the turn's allowances: deletes every row of the run, in its own transaction. */
export async function closeTurnReadAllowances(pool: Pool, runId: string): Promise<void> {
  await withTransaction(pool, (client) => clearForRun(client, runId));
}
