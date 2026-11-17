import { z } from "zod";
import type { PoolClient } from "pg";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import type { ItemRow } from "../types.js";
import { appendHistoryEntry, type ProposalHistoryEntry } from "./proposalHistory.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { RECORDING_PROPERTY_KEYS } from "./recordingCardEnvelope.js";
import {
  composeEffectiveEnvelope,
  parseUserOverrides,
  retainOverridesForEnvelope,
  type RetainedOverrides,
} from "./proposalOverrides.js";

// What a revise does with the user's manual values. Imports neither `proposalActions.ts` nor the tick's writers.

/** A malformed stored envelope has no destination, and a revise may replace it. */
const previousDestinationSchema = z.object({ entityKind: z.string(), target: z.string() });

export interface RetainedRevisionValues extends RetainedOverrides {
  /** What `proposal` holds after the revise: the new assistant envelope with the kept values laid over it. */
  effective: ProposalEnvelope;
}

/**
 * Which manual values survive replacing the assistant envelope with `envelope`, and the effective envelope they make.
 * The caller validates the effective envelope when `userEditedKeys` is not empty, so a kept value is what confirm
 * writes.
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
      : envelope.entityKind === "transcription"
        ? RECORDING_PROPERTY_KEYS
        : Object.keys(envelope.properties),
  );
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
