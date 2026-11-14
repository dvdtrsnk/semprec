import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { appendHistoryEntry, invalidReasonSchema } from "./inboxTickAction.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { lockLiveProposal, type ProposalActionConfig } from "./proposalActions.js";
import { assertProposalVersion, incompatibleStatusError } from "./proposalPreconditions.js";
import { envelopeAllowsRestore } from "./proposalReferenceInvalidation.js";
import { undoConfirmedProposalWithClient, type KeptItem } from "./undoConfirmedProposal.js";

/**
 * The user's return of a decided card to the stack (issues #1937 and #1943), split out of `proposalActions.ts` to keep that file
 * under the ESLint line cap; `proposalActions.ts` re-exports `reopenProposalWithClient`, `ReopenProposalInput` and `ReopenProposalResult`, so
 * callers import them from there. The shared helpers this module takes from `proposalActions.ts` (`lockLiveProposal`)
 * are used only inside functions, so the import cycle does not matter at module load.
 */

export interface ReopenProposalInput {
  /** The card's `updatedAt` as the client read it; a different current value refuses the reopen of a `rejected` or `confirmed` card with a `ConflictError`. */
  ifVersion?: string;
}

/** What a reopen answers: the card, and the items the undo of a confirmation left in place (always empty for any other reopen). */
export interface ReopenProposalResult {
  item: ItemRow;
  keptItems: KeptItem[];
}

/**
 * True when the card keeps the `sourceDeleted` reason it had before it was discarded and that Inbox item is still
 * deleted. Discarding a card writes the status and the history only, so a card that was final-invalid (issue #1482) when
 * the user rejected it still holds its reason, and the stored envelope says nothing about the source. A source that came
 * back while the card was locked is no longer a reason: nothing marked the card then, because the tick skips a locked card.
 */
async function holdsLiveSourceDeletion(client: PoolClient, proposal: ItemRow): Promise<boolean> {
  const reason = invalidReasonSchema.safeParse(proposal.properties.invalidReason);
  if (!reason.success || reason.data.code !== "sourceDeleted") return false;
  const [source] = await itemsStore.getItemsByIds(client, [reason.data.itemId]);
  return source === undefined || source.deletedAt !== null;
}

/**
 * `POST /api/proposals/:id/reopen` (issues #1937 and #1943): returns a card the user decided on to the stack, so the undo of
 * a decision gives back the card with the values it had. Runs in the caller's transaction under the card's row lock.
 *
 * - A `proposed` card is returned unchanged, whatever `ifVersion` says, so a repeated call succeeds and writes nothing.
 * - A `rejected` card keeps its stored `proposal`, `aiProposal`, `userOverrides`, `userEditedKeys` and earlier
 *   history (`docs/adr/2026-11-14-a-rejected-proposal-reopens-without-recomputation.md`). Its stored `proposal` is
 *   validated as the tick validates a computed envelope (`envelopeAllowsRestore`) and the card becomes `proposed` when
 *   it passes, `invalid` when it does not. Nothing is recomputed. One history entry of kind `reopened` is appended
 *   and the Journal inbox recompute is enqueued. The `invalidReason` the card still holds from before its discard is
 *   cleared, because the envelope check decides the status again, with one exception: a `sourceDeleted` reason whose
 *   Inbox item is still deleted (`holdsLiveSourceDeletion`) is kept and the card stays `invalid`, as it was before the
 *   discard; the envelope check cannot see the source, and the tick brings the card back when the source is restored.
 *   This is the one transition out of `rejected`: `LOCKED_PROPOSAL_STATUSES` is not changed, so the tick and revise
 *   keep treating a `rejected` card as locked, and only this action writes the status back.
 * - A `confirmed` card has the writes of its confirmation reversed first (`undoConfirmedProposalWithClient`, following
 *   `docs/adr/2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes.md`), in this transaction. It then
 *   becomes `proposed` with the envelope it was confirmed with, and its `resultItemId`, `resultLabel` and `results` are
 *   cleared. The Files item that received a moved Inbox attachment cannot be reversed and is returned in `keptItems`.
 *   An item changed since the confirmation is a 409 `version_conflict` that names it, and nothing is written.
 * - Any other status (`computing`, `computeFailed`, `needsClarification`, `invalid`) is a 400 `validation_failed` on
 *   field `status` with `details.currentStatus`.
 *
 * `ifVersion` follows the check order of issue #1852: the status is judged first (so a stale version on a card that
 * cannot be reopened answers the 400 of the status), then the version (a 409 `version_conflict` with the card as
 * `details.current`), then the write. `actingUserId` addresses the realtime invalidations of the writes.
 */
export async function reopenProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  input: ReopenProposalInput,
  actingUserId?: string,
): Promise<ReopenProposalResult> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "proposed") return { item: proposal, keptItems: [] };
  if (status !== "rejected" && status !== "confirmed") {
    throw incompatibleStatusError(`Cannot reopen a proposal in status '${String(status)}'`, status);
  }
  assertProposalVersion(proposal, input.ifVersion);

  const history = appendHistoryEntry(proposal.properties.history, "Reopened by user.", "user", { kind: "reopened" });
  let keptItems: KeptItem[] = [];
  let updated: ItemRow;
  if (status === "confirmed") {
    keptItems = await undoConfirmedProposalWithClient(client, proposal, actingUserId);
    updated = await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: proposal.id,
        propertiesPatch: { status: "proposed", resultItemId: null, resultLabel: null, results: null, history },
      },
      {
        allowedSystemKeys: ["status", "resultItemId", "resultLabel", "results", "history"],
        writer: { writerKind: "user" },
        actingUserId,
      },
    );
  } else {
    const sourceStillDeleted = await holdsLiveSourceDeletion(client, proposal);
    const valid = !sourceStillDeleted && (await envelopeAllowsRestore(client, proposal));
    const clearsInvalidReason =
      !sourceStillDeleted &&
      proposal.properties.invalidReason !== undefined &&
      proposal.properties.invalidReason !== null;
    updated = await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: proposal.id,
        propertiesPatch: {
          status: valid ? "proposed" : "invalid",
          ...(clearsInvalidReason ? { invalidReason: null } : {}),
          history,
        },
      },
      { allowedSystemKeys: ["status", "invalidReason", "history"] },
    );
  }
  publishInboxCardChange(client, proposal.id, "updated");
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return { item: updated, keptItems };
}
