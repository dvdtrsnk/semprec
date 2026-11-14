import { z } from "zod";
import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { appendHistoryEntry, isFinalInvalid, readAiProposal } from "./inboxTickAction.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import {
  assertValidEnvelopeForCard,
  lockLiveProposal,
  unsupportedEntityKindError,
  type ProposalActionConfig,
} from "./proposalActions.js";
import { parseUserOverrides } from "./proposalOverrides.js";
import { assertProposalVersion } from "./proposalPreconditions.js";
import { referencedItemIdsOf } from "./proposalReferences.js";

/**
 * The user's return of a proposal card to the assistant's last proposal (issue #1912), split out of
 * `proposalActions.ts` to keep that file under the ESLint line cap; `proposalActions.ts` re-exports
 * `resetProposalOverridesWithClient` and `ResetProposalOverridesInput`, so callers import them from there. The shared
 * helpers this module takes from `proposalActions.ts` (`lockLiveProposal`, `assertValidEnvelopeForCard`,
 * `unsupportedEntityKindError`) are used only inside functions, so the import cycle does not matter at module load.
 */

export interface ResetProposalOverridesInput {
  /** The card's `updatedAt` as the client read it; a different current value refuses the reset with a `ConflictError`. */
  ifVersion?: string;
}

/** The stored `userEditedKeys` (a JSONB boundary): an absent or JSON null value is "no keys"; anything else malformed throws. */
function parseUserEditedKeys(value: unknown, proposalId: string): string[] {
  if (value === null || value === undefined) return [];
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success) throw new Error(`Malformed userEditedKeys on proposal ${proposalId}`);
  return parsed.data;
}

/**
 * `POST /api/proposals/:id/reset-overrides` (issue #1912): discards every manual value of a card and shows what the
 * assistant last proposed. When `userOverrides` or `userEditedKeys` holds anything, one `updateItemWithClient` call
 * writes `userOverrides` `{}`, `userEditedKeys` `[]`, `proposal` as the assistant's last envelope
 * (`readAiProposal`: for a card whose type was refined, the envelope computed for the chosen type) with the
 * `referencedItemIds` of that envelope, a `reset` history entry that lists the keys the user had edited, and the status
 * `proposed`, with the `invalidReason` of a fixable `invalid` card cleared in the same write. The restored envelope is validated as confirm validates it
 * (`assertValidEnvelopeForCard`), so a card whose assistant envelope no longer fits its destination is refused with
 * the `ValidationError` of the field and keeps its manual values. Manual values also cover the relation lists and
 * step switches that issue #1920 stores in `userOverrides`, so those are cleared as well. When nothing is edited the
 * locked card is returned unchanged and nothing is written, history included.
 *
 * Runs in the caller's transaction under the proposal's row lock. Allowed in the statuses a values edit is allowed
 * in: `proposed`, `needsClarification` and a fixable `invalid`. A `confirmed` or `rejected` card, a final `invalid`
 * one (`sourceDeleted`, issue #1482) and a card in any other status are refused with a `ValidationError` before
 * anything else, even when nothing is edited. A `ConflictError` carrying the current card answers an `ifVersion` that
 * is no longer the card's `updatedAt`, also when nothing is edited. A card with manual values and no assistant
 * envelope to return to (a `needsClarification` card) is refused with a `ValidationError`, and one whose envelope
 * has an unknown `entityKind` with the `ConflictError` that confirm answers.
 */
export async function resetProposalOverridesWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  input: ResetProposalOverridesInput,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) {
    throw new ValidationError(`Cannot reset a locked proposal (status '${status}')`, { field: "status" });
  }
  if (status !== "proposed" && status !== "needsClarification" && status !== "invalid") {
    throw new ValidationError(`Cannot reset a proposal in status '${String(status)}'`, { field: "status" });
  }
  if (isFinalInvalid(proposal.properties)) {
    throw new ValidationError("Cannot reset a proposal whose source Inbox item was deleted", { field: "status" });
  }
  assertProposalVersion(proposal, input.ifVersion);

  const editedKeys = parseUserEditedKeys(proposal.properties.userEditedKeys, proposal.id);
  const overrides = parseUserOverrides(proposal.properties.userOverrides, proposal.id);
  if (editedKeys.length === 0 && Object.keys(overrides).length === 0) return proposal;

  const aiEnvelope = readAiProposal(proposal.properties, proposal.id);
  if (aiEnvelope === null) {
    throw new ValidationError("Proposal has no computed envelope to return to", { field: "proposal" });
  }
  if ("unknownKind" in aiEnvelope) throw unsupportedEntityKindError(aiEnvelope.entityKind);
  await assertValidEnvelopeForCard(client, config, proposal, aiEnvelope);

  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        proposal: aiEnvelope,
        referencedItemIds: referencedItemIdsOf(aiEnvelope),
        userOverrides: {},
        userEditedKeys: [],
        status: "proposed",
        ...(status === "invalid" ? { invalidReason: null } : {}),
        history: appendHistoryEntry(proposal.properties.history, "Manual values were reset.", "user", {
          kind: "reset",
          keys: editedKeys,
        }),
      },
    },
    {
      allowedSystemKeys: [
        "proposal",
        "referencedItemIds",
        "userOverrides",
        "userEditedKeys",
        "status",
        ...(status === "invalid" ? ["invalidReason"] : []),
        "history",
      ],
    },
  );
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
}
