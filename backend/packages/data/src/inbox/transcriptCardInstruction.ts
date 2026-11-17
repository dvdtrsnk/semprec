import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { ItemRow } from "../types.js";
import { enqueueTranscriptCardRecompute } from "../transcription/transcriptCardRecompute.js";
import { appendRevisionEntry, type ProposalActionConfig, type ProposalRevisionAuthor } from "./proposalActions.js";
import type { ProposalHistoryEntry } from "./proposalHistory.js";

// The message-only revise of a transcript card. Imports from `proposalActions.ts` are used only inside functions, so
// the import cycle is harmless at module load.

function withLastEntryId(entries: ProposalHistoryEntry[], id: string): ProposalHistoryEntry[] {
  return entries.map((entry, index) => (index === entries.length - 1 ? { ...entry, id } : entry));
}

/**
 * Appends the user's `message` to the locked transcript card's history as a new entry with its own `id`, and in the
 * same transaction enqueues the `transcriptCardRecompute` job naming it. The caller has already refused locked,
 * source-deleted or other-kind cards. A stale `ifVersion` is answered `version_conflict` with nothing written.
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
