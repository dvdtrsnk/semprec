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

/** What step 6 needs from the transcription task, which owns the locks and checkpoints of a run. */
export interface MatchStepEnvironment {
  pool: Pool;
  transcriptId: string;
  /** Locks the Files source, the transcript and the automation, refuses a stopped or locked run, and returns the locked transcript. */
  lockTranscription: (client: PoolClient) => Promise<ItemRow>;
  /** The Files source (row-locked when `lock`) and the recording duration of step 1's checkpoint. */
  readSource: (client: PoolClient, lock: boolean) => Promise<{ source: ItemRow; durationSeconds: number }>;
}

/**
 * Step 6 (`match`, issues #247, #1813 and #1848): links the one Event that overlaps the recording, or
 * creates the transcript's one suggestion card. Only when two or more Events overlap and the
 * `eventRecommendation` checkpoint is absent is one paid `gateway.complete()` call made, to
 * recommend one of them from the meeting notes; zero or one candidate never pays.
 *
 * Bracketed like step 7: a repeatable-read snapshot decides whether a call is due, the call runs
 * outside any transaction, and one transaction then re-locks the transcript, matches again, creates
 * the card and writes the checkpoint on the source Files item together. A replay after that commit
 * makes no second call; a crash before it can repeat the call. A failed call fails the step, and the
 * job retries it. The recommendation only shapes the card; no Event edge is written for it. The
 * match is run again in the write transaction, so a card is made from the candidates of that
 * moment and a recommendation outside them is dropped. A transcript whose `status` is already
 * `done` is not matched at all (issue #1712), checked on the snapshot and again before the write.
 * See docs/adr/2026-11-13-transcription-recommends-the-event-of-an-ambiguous-recording.md.
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
