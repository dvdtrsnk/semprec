import type { Pool } from "pg";
import { createHttpAiGatewayClient } from "@alldots/ai-gateway-client";
import { AiGatewayFailedError, type AiGatewayClientPort } from "@alldots/shared";
import {
  applyTranscriptCardRecompute,
  readTranscriptCardRecomputeSnapshot,
  recordTranscriptCardRecomputeFailure,
  TranscriptCardChangedError,
  transcriptCardRecomputePayloadSchema,
  withTransaction,
  type TranscriptCardRecomputeOutcome,
  type TranscriptCardRecomputePayload,
} from "@alldots/data";
import { logger } from "./logger.js";
import {
  buildTranscriptCardRecomputeRequest,
  parseTranscriptCardRecomputeContent,
} from "./transcriptCardRecomputeRequest.js";

/** A code only: the cause's message could carry the instruction or the recording. */
class TranscriptCardRecomputeError extends Error {
  readonly code: "budgetExceeded" | "providerFailed" | "cardChanged" | "unknown";

  constructor(code: TranscriptCardRecomputeError["code"]) {
    super("Transcript card recompute failed");
    this.name = "TranscriptCardRecomputeError";
    this.code = code;
  }
}

function classifyFailure(error: unknown): TranscriptCardRecomputeError["code"] {
  if (error instanceof AiGatewayFailedError)
    return error.reason === "budget_exceeded" ? "budgetExceeded" : "providerFailed";
  if (error instanceof TranscriptCardChangedError) return "cardChanged";
  return "unknown";
}

export interface TranscriptCardRecomputeJobHelpers {
  job: { attempts: number; max_attempts: number };
}

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

/**
 * Recomputes a transcript card from a user's instruction: a snapshot that skips locked or already
 * answered cards, the gateway call outside any transaction, then one transaction that writes the
 * answer. A moved `aiVersion` fails the attempt so the retry re-reads. The last failing attempt, or
 * a budget refusal at once, records that the instruction could not be applied. Nothing logs the
 * instruction, transcript or answer.
 */
export function createTranscriptCardRecomputeTask(pool: Pool, completionClient?: AiGatewayClientPort) {
  const resolveCompletionClient = (): AiGatewayClientPort =>
    completionClient ??
    createHttpAiGatewayClient({
      port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
      token: requireGatewayInternalToken(),
    });

  const run = async (input: TranscriptCardRecomputePayload): Promise<TranscriptCardRecomputeOutcome> => {
    const snapshot = await withTransaction(pool, (client) => readTranscriptCardRecomputeSnapshot(client, input), {
      isolation: "repeatable_read",
    });
    if (!snapshot) return "skipped";
    const { content } = await resolveCompletionClient().complete(buildTranscriptCardRecomputeRequest(snapshot));
    const answer = parseTranscriptCardRecomputeContent(content);
    return withTransaction(pool, (client) =>
      applyTranscriptCardRecompute(client, { ...input, expectedAiVersion: snapshot.aiVersion, answer }),
    );
  };

  return async (payload: unknown, helpers: TranscriptCardRecomputeJobHelpers): Promise<void> => {
    const input = transcriptCardRecomputePayloadSchema.parse(payload);
    const ids = { proposalId: input.proposalId, instructionEntryId: input.instructionEntryId };
    try {
      logger.info({ ...ids, outcome: await run(input) }, "Transcript card recompute finished");
      return;
    } catch (error) {
      const errorCode = classifyFailure(error);
      const budgetRejected = errorCode === "budgetExceeded";
      if (!budgetRejected && helpers.job.attempts < helpers.job.max_attempts) {
        logger.warn({ ...ids, errorCode, attempt: helpers.job.attempts }, "Transcript card recompute attempt failed");
        throw new TranscriptCardRecomputeError(errorCode);
      }
      try {
        const outcome = await withTransaction(pool, (client) => recordTranscriptCardRecomputeFailure(client, input));
        logger.warn({ ...ids, errorCode, outcome }, "Transcript card recompute failed for good");
      } catch {
        // The attempt's own failure is what the queue must see; this one is only logged.
        logger.error({ ...ids, errorCode }, "Failed to record a transcript card recompute failure");
        throw new TranscriptCardRecomputeError(errorCode);
      }
      if (!budgetRejected) throw new TranscriptCardRecomputeError(errorCode);
    }
  };
}
