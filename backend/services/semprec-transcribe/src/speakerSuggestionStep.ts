import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { AiGatewayClientPort } from "@semprec/shared";
import {
  buildSpeakerSuggestionCheckpoint,
  isSpeakerSuggestionCurrent,
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
  withTransaction,
  writeComputed,
} from "@semprec/data";
import type { ItemRow } from "@semprec/data";
import { buildSpeakerSuggestionRequest, parseSpeakerSuggestionContent } from "./speakerSuggestion.js";

const segmentsSchema = z.array(
  z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }),
);

/** What the speaker suggestion needs from the run that calls it, which owns the locks of its own transactions. */
export interface SpeakerSuggestionEnvironment {
  pool: Pool;
  transcriptId: string;
  filesDatabaseId: string;
  /** The Files item the transcript was made from, which holds the step's checkpoint. */
  fileItemId: string;
  /**
   * A finished transcript (`status = 'done'`) gets no call, no card and no checkpoint when this is set: the pipeline's
   * step, whose later runs only store meeting notes (issue #1712). The task of issue gh-1942 asks about finished
   * transcripts, so it does not set it.
   */
  skipFinished: boolean;
  /** Takes the locks the caller's run needs, throws when it must stop, and returns the locked transcript row. */
  lockRun: (client: PoolClient) => Promise<ItemRow>;
  /** The Files source (row-locked when `lock`), the item the checkpoint is written on. */
  readSource: (client: PoolClient, lock: boolean) => Promise<ItemRow>;
}

/**
 * The speaker suggestion (step 7 of the pipeline and the `transcriptSpeakerSuggestion` task): proposes a card for each
 * unmapped speaker. When candidates exist, one gateway call suggests mappings; otherwise cards need clarification without
 * a call. A repeatable-read snapshot decides whether a call is due, the call runs outside any transaction, and one
 * transaction then re-locks the run, creates or refreshes the cards (`proposeSpeakerMappings`) and writes the checkpoint
 * on the source Files item together. A user must confirm a card before a mapping is written.
 *
 * The checkpoint is bound to what was asked (issue gh-1942): the transcript's Event and the sorted ids of the candidate
 * people. The call is skipped only when the checkpoint holds the Event and candidates of now; otherwise the speakers are
 * asked about again, an old checkpoint without the binding included. A replay after the commit makes no second call; a
 * crash before it can repeat the call. A transcript whose `status` is `done` is left alone when `skipFinished`, read from
 * the locked row before the call and again in the write transaction. See
 * docs/adr/2026-11-14-speaker-suggestions-are-asked-again-when-the-event-or-its-participants-change.md and
 * docs/adr/2026-11-10-finished-transcripts-are-not-matched-or-suggested-again.md.
 */
export async function runSpeakerSuggestion(
  env: SpeakerSuggestionEnvironment,
  completionClient: AiGatewayClientPort,
): Promise<void> {
  const { pool, transcriptId } = env;
  const snapshot = await withTransaction(
    pool,
    async (client) => {
      const locked = await env.lockRun(client);
      if (env.skipFinished && locked.properties.status === "done") return null;
      const segments = segmentsSchema.safeParse(locked.computed[TRANSCRIPT_SEGMENTS_COMPUTED_KEY]);
      // The pipeline's own step reaches this with segments; a job of the task may come before them, and then has nothing to ask.
      if (!segments.success) return null;
      const source = await env.readSource(client, false);
      const context = await readSpeakerSuggestionContext(client, transcriptId);
      if (!context || isSpeakerSuggestionCurrent(source.computed[TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY], context))
        return null;
      return { segments: segments.data, context };
    },
    { isolation: "repeatable_read" },
  );
  if (!snapshot) return;

  const suggestions = snapshot.context.candidates.length
    ? parseSpeakerSuggestionContent(
        (await completionClient.complete(buildSpeakerSuggestionRequest(snapshot.segments, snapshot.context))).content,
      )
    : [];

  await withTransaction(pool, async (client) => {
    const locked = await env.lockRun(client);
    // A run that finished the transcript while the call was out leaves it as that run left it.
    if (env.skipFinished && locked.properties.status === "done") return;
    // Locked, so a concurrent run that checkpointed first is not doubled. What the cards are written for is read
    // again: a participant added while the call was out is not in the answer, and the next job asks about it.
    const source = await env.readSource(client, true);
    const current = await readSpeakerSuggestionContext(client, transcriptId);
    if (!current || isSpeakerSuggestionCurrent(source.computed[TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY], current))
      return;
    const proposedSpeakers = await proposeSpeakerMappings(client, { transcriptId, suggestions });
    await writeComputed(
      client,
      env.filesDatabaseId,
      env.fileItemId,
      TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
      buildSpeakerSuggestionCheckpoint(
        snapshot.context,
        source.computed[TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY],
        proposedSpeakers,
      ),
    );
  });
}
