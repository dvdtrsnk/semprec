import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import {
  assertGatewayTenantActive,
  attributeGatewayCallsToSempMessage,
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
} from "@alldots/data";
import { currentTenantScope } from "@alldots/shared";
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
 * caused by the tenant's own state passes its window so `reserve` can announce it after rollback; an
 * operator-wide cap is never announced, being no tenant's state. A call outside a tenant scope is
 * refused plainly.
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
 * Refuses (`spent >= cap`) when the tenant has no `tenant_ai_budgets` row, its non-null daily or
 * monthly cap is reached (in the tenant's timezone over its rows), or the operator-wide `globalCaps`
 * are reached (in UTC over all rows). A `NULL` tenant cap leaves only the global cap. Called only
 * from `reserve` under the budget lock, so the spend includes every in-flight reservation.
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
 * In one transaction: takes the advisory lock that serializes all reservations, checks the tenant is
 * active (`assertGatewayTenantActive`; inactive and unknown both get `attribution_refused`), checks
 * the budget, and inserts a `reserved` row at the estimate. The lock is released at COMMIT, before
 * the provider call, so calls serialize only on check-and-insert and the next check sees this
 * reservation. A refusal rolls back (no row) and propagates unchanged; a tenant-state refusal is
 * announced by `announceTenantRefusal` after the rollback, which cannot change the error. See
 * docs/architecture/agents-approvals-and-ai.md#budgets-and-accounting.
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

/** Runs `invoke`; on rejection marks the reservation `failed` (cost 0) and rethrows, logging rather than surfacing a cleanup failure. */
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

/** Total settle attempts before the reservation is left `reserved` at its estimate. */
const SETTLE_MAX_ATTEMPTS = 3;
/** Delay before the 2nd and 3rd settle attempt. */
const SETTLE_BACKOFF_MS = [100, 300];

/**
 * Settles a reservation whose provider call succeeded, retrying a rejection with backoff up to
 * `SETTLE_MAX_ATTEMPTS`. Never rejects: the provider is already paid. If every attempt fails the
 * row stays `reserved` at its estimate, so it keeps counting against the cap, and an error log
 * names it for reconciliation. A `null` settle (another path already settled or failed the row) is
 * logged once and not retried.
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
 * Speech synthesis egress point; one ai_gateway_calls row per invocation. The text length gives
 * the price up front, so the row is reserved at `ctx.estimatedCostUsd` (a refusal propagates before
 * `produce` runs) and settled with what `produce` reports. `produce` streams the audio and resolves
 * with what was produced, also after a disconnect; no audio (`audioSeconds <= 0`) or a rejection
 * marks the row `failed`, and a rejection is rethrown.
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
  /** The `ai_gateway_calls.id` of this chunk's row. */
  readonly callId: string;
  /** Settles the row with the audio seconds actually used, retrying a transient database failure. */
  settle(audioSeconds: number, costUsd: number): Promise<void>;
  /** Marks the row `failed` (cost 0); a failure of that cleanup is logged, never thrown. */
  fail(): Promise<void>;
}

/**
 * Streaming audio egress point: the audio length is unknown up front, so the stream reserves chunk
 * by chunk through the same reserve step, one row per chunk at `ctx.estimatedCostUsd` (the price of
 * one full chunk). A `BudgetExceededError` leaves no row. The caller must settle or fail every chunk,
 * including on disconnect.
 */
export async function reserveAudioStreamChunk(pool: Pool, ctx: GatewayCallContext): Promise<AudioStreamChunk> {
  const reservation = await reserve(pool, ctx);
  let finished = false;
  return {
    callId: reservation.id,
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

/**
 * Attributes the given chunk rows, whatever their status, to the Semp assistant message of the turn
 * their audio started, in the ambient tenant. An unknown or invisible message or chunk row is
 * refused with `attribution_refused` and changes nothing; no chunks does nothing.
 */
export function attributeAudioStreamChunks(
  pool: Pool,
  chunks: readonly AudioStreamChunk[],
  sempMessageId: string,
): Promise<void> {
  return attributeGatewayCallsToSempMessage(
    pool,
    chunks.map((chunk) => chunk.callId),
    sempMessageId,
  );
}
