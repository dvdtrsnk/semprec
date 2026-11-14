import { z } from "zod";
import type { PoolClient } from "pg";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { ItemRow } from "../types.js";
import { appendHistoryEntry, type ProposalHistoryEntry } from "./proposalHistory.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import {
  composeEffectiveEnvelope,
  parseUserOverrides,
  retainOverridesForEnvelope,
  type RetainedOverrides,
} from "./proposalOverrides.js";

/**
 * What a revise does with the user's manual values (issue #1924). Split out of `proposalActions.ts` (issue #1892's
 * `userOverrides`, `userEditedKeys`) to keep that file under the ESLint line cap; this module imports neither
 * `proposalActions.ts` nor the tick's writers.
 */

/** What a revise needs of the assistant's previous envelope. A stored envelope that is malformed has no destination, and a revise may replace it. */
const previousDestinationSchema = z.object({ entityKind: z.string(), target: z.string() });

/** The values of a card that a revise keeps, and the effective envelope they make with the revised assistant envelope. */
export interface RetainedRevisionValues extends RetainedOverrides {
  /** The new assistant envelope with the kept values laid over it: what `proposal` holds after the revise. */
  effective: ProposalEnvelope;
}

/**
 * Decides which of the card's manual values survive replacing its assistant envelope by `envelope`
 * (`retainOverridesForEnvelope`) and composes the effective envelope from them. The caller validates the effective
 * envelope when `userEditedKeys` is not empty, so a kept value is what confirm writes.
 */
export async function retainValuesForRevise(
  client: PoolClient,
  proposal: ItemRow,
  envelope: ProposalEnvelope,
): Promise<RetainedRevisionValues> {
  const previous = previousDestinationSchema.safeParse(proposal.properties.aiProposal ?? proposal.properties.proposal);
  const retained = retainOverridesForEnvelope(
    previous.success ? previous.data : null,
    envelope,
    parseUserOverrides(proposal.properties.userOverrides, proposal.id),
    envelope.entityKind === "database"
      ? (await propertiesStore.listPropertiesByDatabase(client, envelope.target)).map((property) => property.key)
      : Object.keys(envelope.properties),
  );
  // `proposal` stays the effective envelope: the values that stay are laid over the new assistant envelope.
  return { ...retained, effective: composeEffectiveEnvelope(envelope, retained.userOverrides) };
}

/** `history` followed, when a manual value was dropped, by a `reset` entry that lists the dropped `ref.key`s. */
export function appendDroppedValuesEntry(
  history: ProposalHistoryEntry[],
  retained: RetainedOverrides,
): ProposalHistoryEntry[] {
  if (retained.droppedKeys.length === 0) return history;
  const droppedReason = retained.reset
    ? "The destination changed, so the manual values were cleared"
    : "These manual values do not fit the new proposal, so they were dropped";
  return appendHistoryEntry(history, `${droppedReason}: ${retained.droppedKeys.join(", ")}.`, "user", {
    kind: "reset",
    keys: retained.droppedKeys,
  });
}
