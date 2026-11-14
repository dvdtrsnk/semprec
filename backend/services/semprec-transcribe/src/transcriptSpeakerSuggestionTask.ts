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

/** What the queue sees of a failed attempt: a code, never the cause, whose message could carry the recording. */
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
 * The handler of `transcriptSpeakerSuggestion` (issue gh-1942): asks the unmapped speakers of one transcript again, with
 * the same suggestion as the pipeline's step 7 (`runSpeakerSuggestion`), after the transcript's Event or the Event's
 * participants changed. The transcript is `done` or still processing, as long as it has `segments`; a transcript
 * without them, one in the Trash or gone, one without a source Files item, and one a user locked get nothing, so the
 * job ends successfully. The call is skipped when the checkpoint holds the Event and candidates of now.
 *
 * The task does not touch `item_automation`: it takes the same locks as a pipeline step (source, transcript, then the
 * automation row, to see a user's lock) and counts no attempt. A failure, a budget refusal of the gateway included, throws an
 * error that carries a code only, so the job fails visibly in the queue rather than ending as a success with nothing
 * written: the task leaves no card, history entry or checkpoint behind, and only a later edge write or a rerun asks again. The
 * transcript and the model's answer are never logged. `completionClient` defaults to `@semprec/ai-gateway-client`'s
 * client, built when the first job runs.
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
