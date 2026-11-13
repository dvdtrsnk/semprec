import type { Pool, PoolClient } from "pg";
import { allowItemsForTurn, clearForRun, listSleepNightReadItemIds, withTransaction } from "@semprec/data";
import { labeledSempMessageRefSchema, sempMessageRefSchema, type SempMessageRef } from "@semprec/shared";

// The one-turn read allowances of a Semp turn (issue #1849;
// docs/adr/2026-11-13-a-user-attached-ref-grants-one-turn-read-access.md): the items a user attached to the message
// of the turn may be read by the run's agent during that turn without a database grant. They are opened when the
// turn starts and cleared when it settles. A sleep night attached to the message opens the items it is computed from
// (issue #1853; docs/adr/2026-11-13-a-sleep-night-ref-opens-the-sleep-data-for-one-turn.md).

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

/**
 * The item ids a stored message context allows the agent to read directly: those of `item`, `block` and
 * `transcriptSegment` refs, each once. A ref that does not parse against the stored-ref schemas names nothing, and the
 * other refs (a mail attachment, an agent run, an approval request, a task occurrence or trace) open no item. A
 * `sleepNight` ref names no item either; the items of its night are found by `openTurnReadAllowances`.
 */
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
 * Starts the turn's allowances in the caller's transaction: deletes what an earlier turn of the run left behind (a
 * crash before its end), then allows the items of this message's stored refs. For a `sleepNight` ref these are the
 * settings item, the plans and the night item of that night (`listSleepNightReadItemIds`). The ids come from the
 * persisted refs of the message, never from a tool argument.
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
