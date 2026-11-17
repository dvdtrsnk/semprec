import type { Pool, PoolClient } from "pg";
import type { AiGatewayClientPort } from "@semprec/shared";
import {
  TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY,
  createTranscriptEventCard,
  matchTranscriptToEvent,
  readEventRecommendationContext,
  withTransaction,
  writeComputed,
} from "@semprec/data";
import type { EventRecommendation, ItemRow } from "@semprec/data";
import { buildEventRecommendationRequest, parseEventRecommendationContent } from "./eventRecommendation.js";

export interface MatchStepEnvironment {
  pool: Pool;
  transcriptId: string;
  /** Locks the Files source, the transcript and the automation, refuses a stopped or locked run, and returns the locked transcript. */
  lockTranscription: (client: PoolClient) => Promise<ItemRow>;
  /** The Files source (row-locked when `lock`) and the recording duration of step 1's checkpoint. */
  readSource: (client: PoolClient, lock: boolean) => Promise<{ source: ItemRow; durationSeconds: number }>;
}

/**
 * Step 6 (`match`): links the one overlapping Event, or creates one suggestion card. Only two or
 * more candidates cost a paid call, which recommends one from the meeting notes; the recommendation
 * only shapes the card, never an edge.
 *
 * The call runs outside any transaction; the write transaction re-locks and matches again, so a
 * recommendation outside the current candidates is dropped. A `done` transcript is not matched,
 * checked on the snapshot and again before the write.
 */
export async function runEventMatch(env: MatchStepEnvironment, completionClient: AiGatewayClientPort): Promise<void> {
  const { pool, transcriptId } = env;
  const snapshot = await withTransaction(
    pool,
    async (client) => {
      if ((await env.lockTranscription(client)).properties.status === "done") return null;
      const { source, durationSeconds } = await env.readSource(client, false);
      if (Object.hasOwn(source.computed, TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY)) return { context: null };
      return { context: await readEventRecommendationContext(client, { transcriptId, durationSeconds }) };
    },
    { isolation: "repeatable_read" },
  );
  if (!snapshot) return;

  const { context } = snapshot;
  const recommendation: EventRecommendation | null = context
    ? parseEventRecommendationContent(
        (
          await completionClient.complete(
            buildEventRecommendationRequest(context.notes, context.candidates, context.locale),
          )
        ).content,
      )
    : null;

  await withTransaction(pool, async (client) => {
    // A run that finished the transcript while the call was out leaves it as that run left it.
    if ((await env.lockTranscription(client)).properties.status === "done") return;
    // Locked, so a concurrent run that checkpointed first is not doubled.
    const { source, durationSeconds } = await env.readSource(client, true);
    const match = await matchTranscriptToEvent(client, { transcriptId, durationSeconds });
    if (typeof match === "string") return;
    const card = await createTranscriptEventCard(client, {
      transcriptId,
      candidates: match.candidates,
      recommendation,
    });
    if (recommendation)
      await writeComputed(client, source.databaseId, source.id, TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY, {
        recommendedEventId: card.recommendedEventId,
        reason: card.reason,
      });
  });
}
