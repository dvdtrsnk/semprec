import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { appendHistoryEntry, invalidReasonSchema } from "./inboxTickAction.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { adoptCreatedNewOptions } from "./proposalNewOptions.js";
import { lockLiveProposal, type ProposalActionConfig } from "./proposalActions.js";
import { assertProposalVersion, incompatibleStatusError } from "./proposalPreconditions.js";
import { envelopeAllowsRestore } from "./proposalReferenceInvalidation.js";
import { undoConfirmedProposalWithClient, type KeptItem } from "./undoConfirmedProposal.js";

// Returns a decided card to the stack; re-exported from `proposalActions.ts`. `lockLiveProposal` is used only inside
// functions, so the import cycle is harmless at module load.

export interface ReopenProposalInput {
  /** A value other than the card's `updatedAt` refuses reopening a `rejected` or `confirmed` card (`ConflictError`). */
  ifVersion?: string;
}

/** The card, and the items an undone confirmation left in place (empty for other reopens). */
export interface ReopenProposalResult {
  item: ItemRow;
  keptItems: KeptItem[];
}

/**
 * True when the card still holds the `sourceDeleted` reason it had when discarded and that Inbox item is still
 * deleted. Discarding writes only status and history; a source restored while the card was locked never cleared the
 * reason, because the tick skips locked cards.
 */
async function holdsLiveSourceDeletion(client: PoolClient, proposal: ItemRow): Promise<boolean> {
  const reason = invalidReasonSchema.safeParse(proposal.properties.invalidReason);
  if (!reason.success || reason.data.code !== "sourceDeleted") return false;
  const [source] = await itemsStore.getItemsByIds(client, [reason.data.itemId]);
  return source === undefined || source.deletedAt !== null;
}

/**
 * `POST /api/proposals/:id/reopen`: returns a decided card to the stack under its row lock. `proposed` is returned
 * unchanged. `rejected` keeps its values and is not recomputed: it becomes `proposed` when its stored `proposal`
 * passes `envelopeAllowsRestore`, else `invalid`, keeping a `sourceDeleted` reason whose source is still deleted;
 * this is the only transition out of `rejected`. `confirmed` first reverses its writes
 * (`undoConfirmedProposalWithClient`) and adopts the options it created; a moved attachment's Files item is returned
 * in `keptItems`. Other statuses are a 400 on `status`, judged before `ifVersion` (409).
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
    // The undo leaves the options the confirmation created: the card uses them by key from now on.
    const adopted = await adoptCreatedNewOptions(client, proposal.properties);
    updated = await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: proposal.id,
        propertiesPatch: {
          status: "proposed",
          resultItemId: null,
          resultLabel: null,
          results: null,
          history,
          ...adopted,
        },
      },
      {
        allowedSystemKeys: ["status", "resultItemId", "resultLabel", "results", "history", ...Object.keys(adopted)],
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
