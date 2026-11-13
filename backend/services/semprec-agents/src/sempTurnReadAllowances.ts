import type { Pool, PoolClient } from "pg";
import { allowItemsForTurn, clearForRun, withTransaction } from "@semprec/data";
import { labeledSempMessageRefSchema, sempMessageRefSchema } from "@semprec/shared";

// The one-turn read allowances of a Semp turn (issue #1849;
// docs/adr/2026-11-13-a-user-attached-ref-grants-one-turn-read-access.md): the items a user attached to the message
// of the turn may be read by the run's agent during that turn without a database grant. They are opened when the
// turn starts and cleared when it settles.

/**
 * The item ids a stored message context allows the agent to read: those of `item`, `block` and `transcriptSegment`
 * refs, each once. A ref that does not parse against the stored-ref schemas names nothing, and the other refs
 * (a mail attachment, an agent run, an approval request, a task occurrence or trace) open no item.
 */
export function readAllowedItemIds(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const entries: unknown[] = stored;
  const ids = new Set<string>();
  for (const entry of entries) {
    const labeled = labeledSempMessageRefSchema.safeParse(entry);
    const ref = labeled.success ? labeled.data : sempMessageRefSchema.safeParse(entry).data;
    if (ref?.kind === "item" || ref?.kind === "block" || ref?.kind === "transcriptSegment") {
      ids.add(ref.itemId.toLowerCase());
    }
  }
  return [...ids];
}

/**
 * Starts the turn's allowances in the caller's transaction: deletes what an earlier turn of the run left behind (a
 * crash before its end), then allows the items of this message's stored refs. The ids come from the persisted refs
 * of the message, never from a tool argument.
 */
export async function openTurnReadAllowances(client: PoolClient, runId: string, stored: unknown): Promise<void> {
  await clearForRun(client, runId);
  await allowItemsForTurn(client, runId, readAllowedItemIds(stored));
}

/** Ends the turn's allowances: deletes every row of the run, in its own transaction. */
export async function closeTurnReadAllowances(pool: Pool, runId: string): Promise<void> {
  await withTransaction(pool, (client) => clearForRun(client, runId));
}
