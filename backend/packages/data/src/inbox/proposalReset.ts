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

// Returns a card to the assistant's last proposal; re-exported from `proposalActions.ts`. The helpers it takes from
// `proposalActions.ts` are used only inside functions, so the import cycle is harmless at module load.

export interface ResetProposalOverridesInput {
  /** A value other than the card's `updatedAt` refuses the reset with a `ConflictError`. */
  ifVersion?: string;
}

/** Parses stored `userEditedKeys` (a JSONB boundary): absent or JSON null is none; other malformed values throw. */
function parseUserEditedKeys(value: unknown, proposalId: string): string[] {
  if (value === null || value === undefined) return [];
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success) throw new Error(`Malformed userEditedKeys on proposal ${proposalId}`);
  return parsed.data;
}

/**
 * `POST /api/proposals/:id/reset-overrides`: discards every manual value (properties, relation lists, step switches)
 * and restores the assistant's last envelope (`readAiProposal`) with its `referencedItemIds`, a `reset` history
 * entry listing the edited keys, status `proposed` and a cleared fixable `invalidReason`, in one update. The restored
 * envelope is validated as confirm validates it, so one that no longer fits is refused and the values stay. With
 * nothing edited the card is returned unchanged.
 *
 * Runs in the caller's transaction under the card's row lock. Allowed in `proposed`, `needsClarification` and fixable
 * `invalid`; other statuses are refused first, then a stale `ifVersion` (`ConflictError`), both even with nothing
 * edited. Manual values without an assistant envelope are a `ValidationError`; an unknown `entityKind` is confirm's
 * `ConflictError`.
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
