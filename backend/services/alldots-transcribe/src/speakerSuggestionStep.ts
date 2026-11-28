import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { AiGatewayClientPort } from "@alldots/shared";
import {
  buildSpeakerSuggestionCheckpoint,
  isSpeakerSuggestionCurrent,
  proposeSpeakerMappings,
  readSpeakerSuggestionContext,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
  withTransaction,
  writeComputed,
} from "@alldots/data";
import type { ItemRow } from "@alldots/data";
import { buildSpeakerSuggestionRequest, parseSpeakerSuggestionContent } from "./speakerSuggestion.js";

const segmentsSchema = z.array(
  z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }),
);

export interface SpeakerSuggestionEnvironment {
  pool: Pool;
  transcriptId: string;
  filesDatabaseId: string;
  /** Holds the step's checkpoint. */
  fileItemId: string;
  /** Set by the pipeline step: a `done` transcript gets no call, card or checkpoint. The standalone task does not set it. */
  skipFinished: boolean;
  /** Takes the locks the caller's run needs, throws when it must stop, and returns the locked transcript row. */
  lockRun: (client: PoolClient) => Promise<ItemRow>;
  /** The Files source (row-locked when `lock`), the item the checkpoint is written on. */
  readSource: (client: PoolClient, lock: boolean) => Promise<ItemRow>;
}

/**
 * Proposes a card per unmapped speaker (one gateway call when candidates exist, else cards that need
 * clarification). The call runs outside any transaction; one transaction then re-locks, writes the
 * cards and the checkpoint. A user must confirm a card before a mapping is written.
 *
 * The checkpoint is bound to the transcript's Event and the sorted candidate ids; the call is
 * skipped only when both still match. A crash before the commit can repeat the call.
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
    // Locked, so a concurrent run's checkpoint is not doubled. Candidates are re-read: one added while the
    // call was out is asked about by the next job.
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
