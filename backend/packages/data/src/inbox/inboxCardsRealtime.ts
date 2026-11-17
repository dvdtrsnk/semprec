import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInboxCardsInvalidation, type InboxCardsInvalidationEvent } from "../realtimeHook.js";

/**
 * Publishes after `client`'s transaction commits, so clients re-read `GET /api/inbox/cards`. `op` is `closed` when the
 * card leaves the stack. The message names the card only, never its content. A rollback publishes nothing; a publish
 * failing after commit is logged by the wired hook and does not undo the write. Every writer of a Processing proposals
 * card must call it in the transaction that writes the card.
 */
export function publishInboxCardChange(
  client: PoolClient,
  cardId: string,
  op: InboxCardsInvalidationEvent["op"],
): void {
  runAfterCommit(client, () => notifyInboxCardsInvalidation({ op, cardId }));
}
