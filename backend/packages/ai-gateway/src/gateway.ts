import type { Pool, PoolClient } from "pg";
import { recordAudioGatewayCall, recordTokenGatewayCall } from "@semprec/data";
import type { AudioCallResult, GatewayCallContext, TokenCallResult } from "./types.js";

async function withTokenAccounting<T extends TokenCallResult>(
  client: Pool | PoolClient,
  ctx: GatewayCallContext,
  invoke: () => Promise<T>,
): Promise<T> {
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
