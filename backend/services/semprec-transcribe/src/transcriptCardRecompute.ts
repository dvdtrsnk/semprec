import type { Pool } from "pg";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import { AiGatewayFailedError, type AiGatewayClientPort } from "@semprec/shared";
import {
  applyTranscriptCardRecompute,
  readTranscriptCardRecomputeSnapshot,
  recordTranscriptCardRecomputeFailure,
  TranscriptCardChangedError,
  transcriptCardRecomputePayloadSchema,
  withTransaction,
  type TranscriptCardRecomputeOutcome,
  type TranscriptCardRecomputePayload,
} from "@semprec/data";
import { logger } from "./logger.js";
import {
  buildTranscriptCardRecomputeRequest,
  parseTranscriptCardRecomputeContent,
} from "./transcriptCardRecomputeRequest.js";

/**
 * The `transcriptCardRecompute` task (issue gh-1940): acts on a user's instruction to a transcript card, the card of
 * an Event or of one speaker. See
 * docs/adr/2026-11-14-transcript-cards-are-recomputed-by-their-producer-on-instruction.md.
 */

/** What the queue sees of a failed attempt: a code, never the cause, whose message could carry the instruction or the recording. */
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

/** The part of graphile-worker's `JobHelpers` the task reads: which attempt of how many this run is. */
export interface TranscriptCardRecomputeJobHelpers {
  job: { attempts: number; max_attempts: number };
}

function requireGatewayInternalToken(): string {
  const token = process.env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return token;
}

/**
 * The handler of `transcriptCardRecompute`, bracketed as the other model steps of this service are
 * (`runEventMatch`): (a) a repeatable-read snapshot of the card, its transcript and its candidates, which skips a
 * locked card and an instruction that its history already answers; (b) the gateway call, outside any transaction;
 * (c) one transaction that row-locks the card and writes the answer (`applyTranscriptCardRecompute`). A job retried
 * after (c) finds the history entry in (a) and makes no second call; one that crashed before (c) can repeat the
 * call. A card whose `aiVersion` moved while the model was asked fails the attempt, so the retry reads it again.
 *
 * A failed attempt throws an error that carries a code only. The last attempt of a job that keeps failing, and a
 * budget refusal at once, leave the card as it was and add a history entry that the instruction could not be
 * applied (`recordTranscriptCardRecomputeFailure`); the budget refusal then ends the job, since the gateway would
 * refuse a retry as well. Nothing here logs the instruction, the transcript or the model's answer. `completionClient`
 * defaults to `@semprec/ai-gateway-client`'s client, built when the first job runs.
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
