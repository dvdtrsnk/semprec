import type { PoolClient } from "pg";
import { sumSettledSempMessageTokens } from "../aiGateway/aiGatewayCallsStore.js";
import { listSempTurnEvents } from "../agentRuns/agentRunEventsStore.js";
import { projectSempReplyChanges, type SempReplyChange } from "./sempReplyChanges.js";
import { projectSempReplySteps, sempTurnDurationMs, type SempReplyStep } from "./sempReplySteps.js";
import { loadSempReplyTargets } from "./sempReplyTargets.js";
import { pairSempToolCalls } from "./sempReplyToolCalls.js";

/**
 * What is stored on the assistant message when its turn ends: `semp_messages.steps`, `duration_ms` and `tokens`
 * (issue #1860) and `changes` (issue #1885).
 */
export interface SempReplySummary {
  steps: SempReplyStep[];
  /** The time of the whole turn, not the sum of its steps; `null` when its events hold no `turn_start`. */
  durationMs: number | null;
  /** The tokens of the settled gateway calls attributed to this message. */
  tokens: { input: number; output: number };
  /** The items the reply changed; `[]` when it changed nothing. */
  changes: SempReplyChange[];
}

/**
 * Builds the summary of the turn that produced `messageId`: its steps and duration from the events of the
 * message's run between `firstEventId` and `lastEventId` (`null` for a turn that ended in an error, which
 * stored no last event), its changed items from the same events, its tokens from the gateway calls attributed to the message. Everything is read with
 * `client`, in the caller's tenant scope: a caller that stores the final status in the same transaction passes
 * that transaction's client, so the summary is read in the transaction that writes it.
 */
export async function buildSempReplySummary(
  client: PoolClient,
  input: { messageId: string; agentRunId: string; firstEventId: string; lastEventId: string | null },
): Promise<SempReplySummary> {
  const events = await listSempTurnEvents(client, input.agentRunId, input.firstEventId, input.lastEventId);
  const targets = await loadSempReplyTargets(client, pairSempToolCalls(events));
  return {
    steps: projectSempReplySteps({ events, targets }),
    changes: projectSempReplyChanges({ events, targets }),
    durationMs: sempTurnDurationMs(events),
    tokens: await sumSettledSempMessageTokens(client, input.messageId),
  };
}
