import type { Pool } from "pg";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import { AiGatewayFailedError, type AiGatewayClientPort } from "@semprec/shared";
import {
  getItemById,
  lockItemById,
  readSpeakerSuggestionSource,
  transcriptSpeakerSuggestionPayloadSchema,
  withTransaction,
} from "@semprec/data";
import { logger } from "./logger.js";
import { runSpeakerSuggestion } from "./speakerSuggestionStep.js";
import {
  requireTranscriptionUnlocked,
  TranscriptionLockedError,
  TranscriptionStoppedError,
} from "./transcriptionTask.js";

/** A code only: the cause's message could carry the recording. */
class TranscriptSpeakerSuggestionError extends Error {
  readonly code: "budgetExceeded" | "providerFailed" | "unknown";

  constructor(code: TranscriptSpeakerSuggestionError["code"]) {
    super("Transcript speaker suggestion failed");
    this.name = "TranscriptSpeakerSuggestionError";
    this.code = code;
  }
}

function classifyFailure(error: unknown): TranscriptSpeakerSuggestionError["code"] {
  if (error instanceof AiGatewayFailedError)
    return error.reason === "budget_exceeded" ? "budgetExceeded" : "providerFailed";
  return "unknown";
}

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

/**
 * Re-runs `runSpeakerSuggestion` after the transcript's Event or its participants changed, for any
 * transcript with `segments`. Trashed, sourceless or locked transcripts end successfully with nothing.
 * Takes the pipeline's locks but counts no attempt. A failure (budget refusal included) throws a
 * code-only error so the job fails visibly. Transcript and answer are never logged.
 */
export function createTranscriptSpeakerSuggestionTask(pool: Pool, completionClient?: AiGatewayClientPort) {
  const resolveCompletionClient = (): AiGatewayClientPort =>
    completionClient ??
    createHttpAiGatewayClient({
      port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
      token: requireGatewayInternalToken(),
    });

  return async (payload: unknown): Promise<void> => {
    const { transcriptId } = transcriptSpeakerSuggestionPayloadSchema.parse(payload);
    try {
      const source = await withTransaction(pool, (client) => readSpeakerSuggestionSource(client, transcriptId));
      if (!source) {
        logger.info(
          { transcriptId, outcome: "skipped" },
          "Transcript speaker suggestion has no transcript to ask about",
        );
        return;
      }
      const { filesDatabaseId, fileItemId } = source;
      await runSpeakerSuggestion(
        {
          pool,
          transcriptId,
          filesDatabaseId,
          fileItemId,
          skipFinished: false,
          lockRun: (client) => requireTranscriptionUnlocked(client, { filesDatabaseId, fileItemId, transcriptId }),
          readSource: async (client, lock) => {
            const item = await (lock ? lockItemById : getItemById)(client, filesDatabaseId, fileItemId);
            if (!item) throw new TranscriptionStoppedError("Files item", fileItemId);
            return item;
          },
        },
        resolveCompletionClient(),
      );
      logger.info({ transcriptId, outcome: "finished" }, "Transcript speaker suggestion finished");
    } catch (error) {
      if (error instanceof TranscriptionLockedError || error instanceof TranscriptionStoppedError) {
        logger.info({ transcriptId, outcome: "skipped" }, "Transcript speaker suggestion has nothing to do");
        return;
      }
      const errorCode = classifyFailure(error);
      logger.warn({ transcriptId, errorCode }, "Transcript speaker suggestion attempt failed");
      throw new TranscriptSpeakerSuggestionError(errorCode);
    }
  };
}
