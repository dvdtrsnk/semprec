import type { Pool, PoolClient } from "pg";
import { getAiBudgets, getGatewaySpend, getSystemTimezone, recordAudioGatewayCall, recordTokenGatewayCall } from "@semprec/data";
import type { AudioCallResult, GatewayCallContext, TokenCallResult } from "./types.js";

/** Thrown by `assertWithinBudget` when a non-null daily/monthly cap is already reached. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Before each provider call (#120): a null cap never blocks; a non-null cap already reached
 * or exceeded rejects the call outright rather than letting it proceed. Check-then-act, no
 * lock — concurrent calls near the cap may jointly overshoot slightly, which the issue
 * accepts rather than serializing gateway calls.
 */
async function assertWithinBudget(client: Pool | PoolClient): Promise<void> {
  const { dailyBudgetUsd, monthlyBudgetUsd } = await getAiBudgets(client);
  if (dailyBudgetUsd === null && monthlyBudgetUsd === null) return;

  const timezone = await getSystemTimezone(client);
  const { spentToday, spentMonth } = await getGatewaySpend(client, timezone);
  if (dailyBudgetUsd !== null && spentToday >= dailyBudgetUsd) {
    throw new BudgetExceededError(`Daily AI budget of $${dailyBudgetUsd} reached (spent $${spentToday} today)`);
  }
  if (monthlyBudgetUsd !== null && spentMonth >= monthlyBudgetUsd) {
    throw new BudgetExceededError(`Monthly AI budget of $${monthlyBudgetUsd} reached (spent $${spentMonth} this month)`);
  }
}

async function withTokenAccounting<T extends TokenCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  await assertWithinBudget(client);
  const result = await invoke();
  await recordTokenGatewayCall(client, {
    provider: ctx.provider,
    model: ctx.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    agentRunId: ctx.agentRunId,
  });
  return result;
}

async function withAudioAccounting<T extends AudioCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  await assertWithinBudget(client);
  const result = await invoke();
  await recordAudioGatewayCall(client, {
    provider: ctx.provider,
    model: ctx.model,
    audioSeconds: result.audioSeconds,
    costUsd: result.costUsd,
    agentRunId: ctx.agentRunId,
  });
  return result;
}

/** Chat/completion egress point. Records exactly one ai_gateway_calls row per invocation. */
export function complete<T extends TokenCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withTokenAccounting(client, ctx, invoke);
}

/** Embedding egress point. Records exactly one ai_gateway_calls row per invocation. */
export function embed<T extends TokenCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withTokenAccounting(client, ctx, invoke);
}

/** Transcription egress point. Records exactly one ai_gateway_calls row per invocation. */
export function transcribe<T extends AudioCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withAudioAccounting(client, ctx, invoke);
}

/** Diarization egress point. Records exactly one ai_gateway_calls row per invocation. */
export function diarize<T extends AudioCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
  return withAudioAccounting(client, ctx, invoke);
}
