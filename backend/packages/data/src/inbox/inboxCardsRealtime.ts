import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInboxCardsInvalidation, type InboxCardsInvalidationEvent } from "../realtimeHook.js";

/**
 * Announces, once the transaction on `client` has committed, that one card of the Processing
 * proposals stack changed, so a client re-reads `GET /api/inbox/cards` and its count. `op` is
 * `closed` when the card leaves the stack (confirmed or rejected), `created` for a new card and
 * `updated` for any other change. The message names the card only, never its content. A rollback
 * publishes nothing, and a publish that fails after the commit is logged by the wired hook and
 * does not fail or undo the card write.
 *
 * The writers of a Processing proposals card call it in the transaction that writes the card: the tick,
 * the card actions and the transcription card producers (issue #1811). Writers added later (the revise
 * route, issue #1870, the edit routes and the reject route, issue #1845) are to call it when they are built.
 * `semprec-api`, `semprec-agents` and `semprec-transcribe` each wire the hook through `wireRealtimeHooks`,
 * and Postgres stamps the tenant from the scope the write ran in.
 */
export function publishInboxCardChange(
  client: PoolClient,
  cardId: string,
  op: InboxCardsInvalidationEvent["op"],
): void {
  runAfterCommit(client, () => notifyInboxCardsInvalidation({ op, cardId }));
}
