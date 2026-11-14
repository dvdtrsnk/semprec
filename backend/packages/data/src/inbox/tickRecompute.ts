import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { retainValuesForRevise } from "./proposalRetention.js";
import { appendHistoryEntry, type ProposalHistoryEntry } from "./proposalHistory.js";
import type { UserOverrides } from "./proposalOverrides.js";

/**
 * What the tick's write phase decides about a Processing proposal that already exists (issue #1921). Split out of
 * `inboxTickAction.ts` to keep that file under the ESLint line cap; this module imports neither that file nor the
 * writers that call it.
 */

/** The write counter of a card's assistant output; a row without one counts as 0, as `aiProposalPatch` counts it. */
function aiVersionOf(properties: Record<string, unknown>): number {
  return typeof properties.aiVersion === "number" ? properties.aiVersion : 0;
}

/**
 * Whether the assistant's side of `locked` differs from `snapshot`, the row the tick read before it called the model:
 * another fingerprint, or another `aiVersion` (an assistant write, such as a revise through the thread or a second tick).
 * A manual edit changes neither, so the result computed from `snapshot` is still current after one; the row's
 * `updatedAt` is deliberately not compared.
 */
export function assistantSideChanged(locked: ItemRow, snapshot: ItemRow): boolean {
  return (
    (locked.properties.fingerprint ?? null) !== (snapshot.properties.fingerprint ?? null) ||
    aiVersionOf(locked.properties) !== aiVersionOf(snapshot.properties)
  );
}

/** The history message of a tick recompute that dropped no manual value. */
const RECOMPUTE_MESSAGE = "Revised the proposal after the source item changed.";

/** What a recompute writes besides the assistant's own parts. */
export interface RecomputedCardValues {
  /** The new assistant envelope with the kept manual values laid over it: what `proposal` holds. */
  effective: ProposalEnvelope;
  userOverrides: UserOverrides;
  userEditedKeys: string[];
  /** `history` of the locked row followed by one `recompute` entry; it names the manual values that were dropped. */
  history: ProposalHistoryEntry[];
}

/**
 * Merges the assistant's new `envelope` with the manual values stored on `locked`, which the caller holds under the
 * row lock. The values that still apply stay in `userOverrides` and in the effective envelope; the ones that cannot
 * apply (another `entityKind` or `target` than the previous assistant envelope's, a key the new target does not have,
 * or a step other than the destination) are dropped and named in the history entry. A value equal to the new
 * assistant value leaves `userEditedKeys` without being reported.
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
