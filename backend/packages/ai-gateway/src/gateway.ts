import type { Pool, PoolClient } from "pg";
import {
  failGatewayCall,
  getAiBudgetsWithTimezone,
  getGatewaySpend,
  reserveGatewayCall,
  settleAudioGatewayCall,
  settleTokenGatewayCall,
  withTransaction,
  type AiGatewayCallRow,
} from "@semprec/data";
import { logger } from "./logger.js";
import type { AudioCallResult, GatewayCallContext, TokenCallResult } from "./types.js";

/** Thrown by `assertWithinBudget` when a non-null daily/monthly cap is already reached. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Rejects when a non-null daily/monthly cap is already reached or exceeded (#120); a null cap
 * never blocks. Called only from `reserve`, under the budget lock, so the spend it reads includes
 * every other in-flight reservation at its estimate.
 */
async function assertWithinBudget(client: Pool | PoolClient): Promise<void> {
  const { dailyBudgetUsd, monthlyBudgetUsd, timezone } = await getAiBudgetsWithTimezone(client);
  if (dailyBudgetUsd === null && monthlyBudgetUsd === null) return;

  const { spentToday, spentMonth } = await getGatewaySpend(client, timezone);
  if (dailyBudgetUsd !== null && spentToday >= dailyBudgetUsd) {
    throw new BudgetExceededError(`Daily AI budget of $${dailyBudgetUsd} reached (spent $${spentToday} today)`);
  }
  if (monthlyBudgetUsd !== null && spentMonth >= monthlyBudgetUsd) {
    throw new BudgetExceededError(
      `Monthly AI budget of $${monthlyBudgetUsd} reached (spent $${spentMonth} this month)`,
    );
  }
}

/**
 * #620: before each provider call, one transaction takes a transaction-scoped advisory lock that
 * serializes every gateway reservation, checks the budget, and inserts a `reserved` row at the
 * caller's estimate. The lock is released at COMMIT, before the provider is called, so concurrent
 * calls serialize only on the check-and-insert, never on the provider round trip — and the next
 * caller's budget check already sees this call's reservation. A `BudgetExceededError` rolls the
 * transaction back (no row) and propagates unchanged. The lock key and the reserve/settle/fail
 * lifecycle are docs/adr/2026-09-27-ai-budget-reservations-under-a-global-advisory-lock.md.
 */
function reserve(pool: Pool, ctx: GatewayCallContext): Promise<AiGatewayCallRow> {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ai_gateway_budget'))");
    await assertWithinBudget(tx);
    return reserveGatewayCall(tx, {
      provider: ctx.provider,
      model: ctx.model,
      agentRunId: ctx.agentRunId,
      projectItemId: ctx.projectItemId,
      operation: ctx.operation,
      estimatedCostUsd: ctx.estimatedCostUsd,
    });
  });
}

/**
 * Runs `invoke` against a reservation; when it rejects, marks the reservation `failed` (cost 0)
 * and rethrows the original error — a failure of that cleanup is logged, never surfaced in its
 * place.
 */
async function invokeReserved<T>(
  pool: Pool,
  ctx: GatewayCallContext,
  reservation: AiGatewayCallRow,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (invokeErr) {
    try {
      await failGatewayCall(pool, reservation.id);
    } catch (err) {
      logger.error(
        { err, callId: reservation.id, provider: ctx.provider, model: ctx.model },
        "Failed to mark the AI gateway reservation failed after the provider call rejected",
      );
    }
    throw invokeErr;
  }
}

/*
 * A settle failure propagates and deliberately leaves the reservation `reserved` at its estimate:
 * the provider has already been paid, so failing the row at cost 0 would under-report real spend
 * and let later calls exceed the cap (see the ADR above).
 */
async function withTokenAccounting<T extends TokenCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  const reservation = await reserve(pool, ctx);
  const result = await invokeReserved(pool, ctx, reservation, invoke);
  await settleTokenGatewayCall(pool, reservation.id, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  });
  return result;
}

async function withAudioAccounting<T extends AudioCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  const reservation = await reserve(pool, ctx);
  const result = await invokeReserved(pool, ctx, reservation, invoke);
  await settleAudioGatewayCall(pool, reservation.id, {
    audioSeconds: result.audioSeconds,
    costUsd: result.costUsd,
  });
  return result;
}

/** Chat/completion egress point. Records exactly one ai_gateway_calls row per invocation. */
export function complete<T extends TokenCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withTokenAccounting(pool, ctx, invoke);
}

/** Embedding egress point. Records exactly one ai_gateway_calls row per invocation. */
export function embed<T extends TokenCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withTokenAccounting(pool, ctx, invoke);
}

/** Transcription egress point. Records exactly one ai_gateway_calls row per invocation. */
export async function transcribe<T extends AudioCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  const result = await withAudioAccounting(pool, ctx, invoke);
  logger.info({ agentRunId: ctx.agentRunId, provider: ctx.provider, model: ctx.model }, "Transcription completed");
  return result;
}

/** Diarization egress point. Records exactly one ai_gateway_calls row per invocation. */
export function diarize<T extends AudioCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withAudioAccounting(pool, ctx, invoke);
}
