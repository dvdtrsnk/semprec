import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import {
  assertGatewayTenantActive,
  failGatewayCall,
  getCurrentTenantAiBudget,
  getGatewaySpend,
  getGlobalGatewaySpend,
  getSystemTimezone,
  reserveGatewayCall,
  settleAudioGatewayCall,
  settleTokenGatewayCall,
  withTransaction,
  type AiGatewayCallRow,
} from "@semprec/data";
import { logger } from "./logger.js";
import type { AudioCallResult, GatewayCallContext, GlobalAiCaps, TokenCallResult } from "./types.js";

/** The one message every budget refusal carries, so no caller can tell which cap tripped. */
export const BUDGET_EXCEEDED_MESSAGE = "AI budget exceeded";

/** Thrown by `assertWithinBudget` when the tenant has no budget or a tenant or global cap is reached. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

type BudgetLimit = "noTenantBudget" | "tenantDaily" | "tenantMonthly" | "globalDaily" | "globalMonthly";

/** Logs which limit refused (never an amount or content) and throws the constant refusal. */
function refuse(limit: BudgetLimit): never {
  logger.warn({ limit }, "AI gateway call refused: budget exceeded");
  throw new BudgetExceededError(BUDGET_EXCEEDED_MESSAGE);
}

/**
 * Refuses (`spent >= cap`) when the caller's tenant has no `tenant_ai_budgets` row, when its own
 * non-null daily/monthly cap is reached (measured in the tenant's timezone over its own rows), or
 * when the operator-wide `globalCaps` are reached (measured in UTC over every tenant's rows). A
 * `NULL` tenant cap means that window has no per-tenant cap; the global cap still applies. Called
 * only from `reserve`, under the budget lock, so the spend it reads includes every other in-flight
 * reservation at its estimate. Every refusal carries the same message.
 */
async function assertWithinBudget(client: PoolClient, globalCaps: GlobalAiCaps): Promise<void> {
  const budget = await getCurrentTenantAiBudget(client);
  if (budget === null) refuse("noTenantBudget");

  const timezone = await getSystemTimezone(client);
  const tenantSpend = await getGatewaySpend(client, timezone);
  if (budget.dailyCapUsd !== null && tenantSpend.spentToday >= budget.dailyCapUsd) refuse("tenantDaily");
  if (budget.monthlyCapUsd !== null && tenantSpend.spentMonth >= budget.monthlyCapUsd) refuse("tenantMonthly");

  const globalSpend = await getGlobalGatewaySpend(client);
  if (globalSpend.spentToday >= globalCaps.dailyCapUsd) refuse("globalDaily");
  if (globalSpend.spentMonth >= globalCaps.monthlyCapUsd) refuse("globalMonthly");
}

/**
 * #620: before each provider call, one transaction takes a transaction-scoped advisory lock that
 * serializes every gateway reservation, then checks that the caller's tenant exists and is active
 * (`assertGatewayTenantActive`, so an inactive and an unknown tenant get the same
 * `attribution_refused`), then checks the budget, and then inserts a `reserved` row at the
 * caller's estimate. The lock is released at COMMIT, before the provider is called, so concurrent
 * calls serialize only on the check-and-insert, never on the provider round trip — and the next
 * caller's budget check already sees this call's reservation. A `BudgetExceededError`, or the
 * tenant check's `ForbiddenError`, rolls the transaction back (no row) and propagates unchanged. The lock key and the reserve/settle/fail
 * lifecycle are docs/adr/2026-09-27-ai-budget-reservations-under-a-global-advisory-lock.md.
 */
function reserve(pool: Pool, ctx: GatewayCallContext): Promise<AiGatewayCallRow> {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ai_gateway_budget'))");
    await assertGatewayTenantActive(tx);
    await assertWithinBudget(tx, ctx.globalCaps);
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

/** Total settle attempts before the reservation is left `reserved` at its estimate (#623). */
const SETTLE_MAX_ATTEMPTS = 3;
/** Delay before the 2nd and 3rd settle attempt. */
const SETTLE_BACKOFF_MS = [100, 300];

/**
 * Runs `settle` for a reservation whose provider call already succeeded, retrying a rejection
 * (a transient database failure) with backoff up to `SETTLE_MAX_ATTEMPTS` times. It never rejects:
 * the provider has already been paid, so the caller gets its result regardless. When every attempt
 * fails, the row deliberately stays `reserved` at its estimate — it keeps counting against the cap
 * rather than under-reporting real spend — and an error-level log line names it for reconciliation.
 * A `null` settle (no `reserved` row matched — someone else already settled or failed it) is not
 * transient, so it is logged once at error level and not retried.
 */
async function settleWithRetry(
  row: AiGatewayCallRow,
  settle: () => Promise<AiGatewayCallRow | null>,
  ctx: GatewayCallContext,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let settled: AiGatewayCallRow | null;
    try {
      settled = await settle();
    } catch (err) {
      if (attempt >= SETTLE_MAX_ATTEMPTS) {
        logger.error(
          {
            err,
            callId: row.id,
            attempts: SETTLE_MAX_ATTEMPTS,
            provider: ctx.provider,
            model: ctx.model,
            estimatedCostUsd: ctx.estimatedCostUsd,
          },
          "ai_gateway_calls settle failed; row left reserved at its estimate",
        );
        return;
      }
      logger.warn(
        { err, callId: row.id, attempt, provider: ctx.provider, model: ctx.model },
        "ai_gateway_calls settle failed, retrying",
      );
      await sleep(SETTLE_BACKOFF_MS[attempt - 1] ?? 0);
      continue;
    }
    if (settled === null) {
      logger.error(
        { callId: row.id, provider: ctx.provider, model: ctx.model },
        "ai_gateway_calls settle matched no reserved row; it was already settled or failed",
      );
    }
    return;
  }
}

async function withTokenAccounting<T extends TokenCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  const reservation = await reserve(pool, ctx);
  const result = await invokeReserved(pool, ctx, reservation, invoke);
  await settleWithRetry(
    reservation,
    () =>
      settleTokenGatewayCall(pool, reservation.id, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      }),
    ctx,
  );
  return result;
}

async function withAudioAccounting<T extends AudioCallResult>(
  pool: Pool,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  const reservation = await reserve(pool, ctx);
  const result = await invokeReserved(pool, ctx, reservation, invoke);
  await settleWithRetry(
    reservation,
    () => settleAudioGatewayCall(pool, reservation.id, { audioSeconds: result.audioSeconds, costUsd: result.costUsd }),
    ctx,
  );
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
