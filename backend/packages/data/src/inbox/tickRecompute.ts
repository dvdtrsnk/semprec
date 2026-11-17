import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { retainValuesForRevise } from "./proposalRetention.js";
import { appendHistoryEntry, type ProposalHistoryEntry } from "./proposalHistory.js";
import type { UserOverrides } from "./proposalOverrides.js";

// What the tick's write phase decides about an existing proposal. Imports neither `inboxTickAction.ts` nor its writers.

/** A row without one counts as 0, as in `aiProposalPatch`. */
function aiVersionOf(properties: Record<string, unknown>): number {
  return typeof properties.aiVersion === "number" ? properties.aiVersion : 0;
}

/**
 * Whether the assistant's side changed since `snapshot` (read before the model call): another fingerprint or
 * `aiVersion`. A manual edit changes neither, so the result stays current; `updatedAt` is deliberately not compared.
 */
export function assistantSideChanged(locked: ItemRow, snapshot: ItemRow): boolean {
  return (
    (locked.properties.fingerprint ?? null) !== (snapshot.properties.fingerprint ?? null) ||
    aiVersionOf(locked.properties) !== aiVersionOf(snapshot.properties)
  );
}

const RECOMPUTE_MESSAGE = "Revised the proposal after the source item changed.";

export interface RecomputedCardValues {
  /** What `proposal` holds: the new assistant envelope with the kept manual values laid over it. */
  effective: ProposalEnvelope;
  userOverrides: UserOverrides;
  userEditedKeys: string[];
  /** The locked row's `history` plus one `recompute` entry naming dropped manual values. */
  history: ProposalHistoryEntry[];
}

/**
 * Merges the new assistant `envelope` with the manual values on `locked` (held under the row lock). Values that cannot
 * apply (changed destination, a key the target lacks, another step) are dropped and named in the history entry.
 */
export async function mergeRecomputeWithManualValues(
  client: PoolClient,
  locked: ItemRow,
  envelope: ProposalEnvelope,
): Promise<RecomputedCardValues> {
  const retained = await retainValuesForRevise(client, locked, envelope);
  const message =
    retained.droppedKeys.length === 0
      ? RECOMPUTE_MESSAGE
      : `${RECOMPUTE_MESSAGE} Manual values that no longer apply were dropped: ${retained.droppedKeys.join(", ")}.`;
  return {
    effective: retained.effective,
    userOverrides: retained.userOverrides,
    userEditedKeys: retained.userEditedKeys,
    history: appendHistoryEntry(locked.properties.history, message, "ai", { kind: "recompute" }),
  };
}
