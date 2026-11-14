import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { enqueueTranscriptCardRecompute } from "../transcription/transcriptCardRecompute.js";
import { appendRevisionEntry, type ProposalActionConfig, type ProposalRevisionAuthor } from "./proposalActions.js";
import type { ProposalHistoryEntry } from "./proposalHistory.js";

/**
 * The message-only revise of a transcript card (issue gh-1940), split out of `proposalActions.ts` to keep that file
 * under the ESLint line cap. The helpers this module takes from `proposalActions.ts` are used only inside functions,
 * so the import cycle does not matter at module load, as for `proposalThreadRevision.ts`.
 */

/** `entries` with `id` set on the last one, the entry `appendRevisionEntry` just added. */
function withLastEntryId(entries: ProposalHistoryEntry[], id: string): ProposalHistoryEntry[] {
  return entries.map((entry, index) => (index === entries.length - 1 ? { ...entry, id } : entry));
}

/**
 * Appends the user's `message` to the history of the locked transcript card `proposal`, as the entry of `revisedBy`
 * with an `id` of its own, and in the same transaction enqueues the `transcriptCardRecompute` job that names that
 * entry. Nothing else on the card changes. The caller has locked the card and refused one that is locked, deleted at
 * the source or of another kind, so a refused card enqueues nothing. `ifVersion` is the card's `updatedAt` as the
 * caller read it: a card that differs is answered `version_conflict` and neither the entry nor the job is written.
 */
export async function recordTranscriptCardInstruction(
  client: PoolClient,
  config: ProposalActionConfig,
  proposal: ItemRow,
  input: { message: string; ifVersion?: string | undefined },
  revisedBy: ProposalRevisionAuthor,
  actingUserId?: string,
): Promise<ItemRow> {
  const instructionEntryId = randomUUID();
  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        history: withLastEntryId(
          appendRevisionEntry(proposal.properties.history, input.message, revisedBy),
          instructionEntryId,
        ),
      },
      ifVersion: input.ifVersion,
    },
    { allowedSystemKeys: ["history"], actingUserId },
  );
  await enqueueTranscriptCardRecompute(client, { proposalId: proposal.id, instructionEntryId });
  return updated;
}
