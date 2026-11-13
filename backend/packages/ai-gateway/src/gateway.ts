import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import {
  assertGatewayTenantActive,
  failGatewayCall,
  findExhaustedWindow,
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
import { currentTenantScope } from "@semprec/shared";
import { logger } from "./logger.js";
import { announceTenantRefusal, type TenantRefusalNotice } from "./tenantRefusalAnnouncement.js";
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

/**
 * A refusal caused by the tenant's own budget state. It is thrown inside the reservation transaction,
 * carries what `announceTenantRefusal` needs, and never leaves `reserve`: the transaction rolls back,
 * the announcement runs, and the caller receives a plain `BudgetExceededError`.
 */
class TenantBudgetRefusal extends BudgetExceededError {
  constructor(readonly notice: TenantRefusalNotice) {
    super(BUDGET_EXCEEDED_MESSAGE);
  }
}

/**
 * Logs which limit refused (never an amount or content) and throws the constant refusal. A refusal
 * caused by the tenant's own state passes the window it belongs to, so `reserve` can announce it once
 * the transaction has rolled back; an operator-wide cap passes none and is never announced, because it
 * is not the tenant's state. The announcement needs the tenant of the active scope, so a refusal of a
 * call that ran in none is plain.
 */
function refuse(limit: BudgetLimit, budgetWindow?: Pick<TenantRefusalNotice, "window" | "timezone">): never {
  logger.warn({ limit }, "AI gateway call refused: budget exceeded");
  const scope = currentTenantScope();
  if (budgetWindow && scope?.kind === "tenant") {
    throw new TenantBudgetRefusal({ tenantId: scope.tenantId, ...budgetWindow });
  }
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
  if (budget === null) refuse("noTenantBudget", { window: "noBudget", timezone: null });

  const timezone = await getSystemTimezone(client);
  const tenantSpend = await getGatewaySpend(client, timezone);
  const exhausted = findExhaustedWindow(budget, tenantSpend);
  if (exhausted !== null) {
    // The daily cap is checked first, so it names the refusal when both caps are reached.
    const dailyReached = budget.dailyCapUsd !== null && tenantSpend.spentToday >= budget.dailyCapUsd;
    refuse(dailyReached ? "tenantDaily" : "tenantMonthly", { window: exhausted, timezone });
  }

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
 * tenant check's `ForbiddenError`, rolls the transaction back (no row) and propagates unchanged.
 * Once a refusal caused by the tenant's own budget state has rolled back, `announceTenantRefusal`
 * runs before the error propagates; it cannot change the error. The lock key and the reserve/settle/fail lifecycle are
 * docs/adr/2026-09-27-ai-budget-reservations-under-a-global-advisory-lock.md.
 */
async function reserve(pool: Pool, ctx: GatewayCallContext): Promise<AiGatewayCallRow> {
  try {
    return await withTransaction(pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('ai_gateway_budget'))");
      await assertGatewayTenantActive(tx);
      await assertWithinBudget(tx, ctx.globalCaps);
      return reserveGatewayCall(tx, {
        provider: ctx.provider,
        model: ctx.model,
        agentRunId: ctx.agentRunId,
        sempMessageId: ctx.sempMessageId,
        projectItemId: ctx.projectItemId,
        operation: ctx.operation,
        estimatedCostUsd: ctx.estimatedCostUsd,
      });
    });
  } catch (err) {
    if (!(err instanceof TenantBudgetRefusal)) throw err;
    // The transaction has rolled back, so nothing is announced from inside the budget lock.
    await announceTenantRefusal(pool, err.notice);
    throw new BudgetExceededError(BUDGET_EXCEEDED_MESSAGE);
  }
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

/** Internal: `synthesizeSpeech`'s `produce` returned no audio, so the row is failed. */
class SpeechNotProducedError extends Error {}

/**
 * Speech synthesis egress point (docs/adr/2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech.md).
 * Records exactly one ai_gateway_calls row per invocation. The text length gives the price up
 * front, so the row is reserved at `ctx.estimatedCostUsd` through the same reserve step as every
 * other call (a refusal propagates before `produce` runs, leaving no row), then settled with the
 * seconds and cost `produce` reports. `produce` streams the audio itself and resolves with what was
 * actually produced, also when the caller disconnected part-way; a result with no audio
 * (`audioSeconds <= 0`) marks the row `failed`, and so does a rejection, which is rethrown.
 */
export async function synthesizeSpeech(
  pool: Pool,
  ctx: GatewayCallContext,
  produce: () => Promise<AudioCallResult>,
): Promise<AudioCallResult> {
  const reservation = await reserve(pool, ctx);
  const result = await invokeReserved(pool, ctx, reservation, async () => {
    const produced = await produce();
    if (!(produced.audioSeconds > 0)) throw new SpeechNotProducedError();
    return produced;
  }).catch((err: unknown) => {
    // A call that produced nothing is not an error of its own: the row is failed, the caller sees the result.
    if (err instanceof SpeechNotProducedError) return null;
    throw err;
  });
  if (result === null) return { audioSeconds: 0, costUsd: 0 };
  await settleWithRetry(
    reservation,
    () => settleAudioGatewayCall(pool, reservation.id, { audioSeconds: result.audioSeconds, costUsd: result.costUsd }),
    ctx,
  );
  return result;
}

/**
 * One reserved slice of a streamed audio call (see `reserveAudioStreamChunk`). Exactly one of
 * `settle` and `fail` takes effect; later calls are no-ops. Neither ever rejects.
 */
export interface AudioStreamChunk {
  /** Settles the row with the audio seconds actually used, retrying a transient database failure. */
  settle(audioSeconds: number, costUsd: number): Promise<void>;
  /** Marks the row `failed` (cost 0); a failure of that cleanup is logged, never thrown. */
  fail(): Promise<void>;
}

/**
 * Streaming audio egress point (docs/adr/2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech.md):
 * the audio length is unknown up front, so the stream reserves it chunk by chunk. Each call runs the
 * same reserve step as every other call (advisory lock, tenant-active check, tenant and global
 * caps) and records one `ai_gateway_calls` row at `ctx.estimatedCostUsd`, which the caller sets to
 * the price of one full chunk. A `BudgetExceededError` propagates and leaves no row. The caller
 * must settle or fail every chunk it receives, including on disconnect.
 */
export async function reserveAudioStreamChunk(pool: Pool, ctx: GatewayCallContext): Promise<AudioStreamChunk> {
  const reservation = await reserve(pool, ctx);
  let finished = false;
  return {
    async settle(audioSeconds, costUsd) {
      if (finished) return;
      finished = true;
      await settleWithRetry(
        reservation,
        () => settleAudioGatewayCall(pool, reservation.id, { audioSeconds, costUsd }),
        ctx,
      );
    },
    async fail() {
      if (finished) return;
      finished = true;
      try {
        await failGatewayCall(pool, reservation.id);
      } catch (err) {
        logger.error(
          { err, callId: reservation.id, provider: ctx.provider, model: ctx.model },
          "Failed to mark the AI gateway stream chunk reservation failed",
        );
      }
    },
  };
}
