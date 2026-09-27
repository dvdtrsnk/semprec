import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";

const GATEWAY_PROVIDER_ID = "semprec-ai-gateway";

/**
 * Upper bound on one model call, SSE stream included: the gateway is a local process, but one
 * that accepts the request and then stops answering must not hold an agent run open forever.
 */
const GATEWAY_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface GatewayModel {
  model: Model<Api>;
  streamFn: StreamFn;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The one model every agent session in this process talks to (issue #647): pi's `pi-messages`
 * protocol pointed at `semprec-ai-gateway`, so every call leaves this process only as
 * `POST <AI_GATEWAY_BASE_URL>/messages` with `Authorization: Bearer <AI_GATEWAY_INTERNAL_TOKEN>`
 * — no provider key or provider SDK ever exists here
 * (docs/adr/2026-09-10-ai-gateway-monopoly-on-provider-calls.md). Throws naming the first missing
 * variable, so `semprec-agents` refuses to start without all three.
 */
export function createGatewayModel(env: NodeJS.ProcessEnv): GatewayModel {
  const baseUrl = requireEnv(env, "AI_GATEWAY_BASE_URL");
  const token = requireEnv(env, "AI_GATEWAY_INTERNAL_TOKEN");
  const modelId = requireEnv(env, "AGENT_MODEL");

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: "pi-messages",
    provider: GATEWAY_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    // Pricing and limits are the gateway's business (it records `ai_gateway_calls` cost itself);
    // 0 is pi's "unknown" for both limits, so nothing here clamps a request.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: GATEWAY_PROVIDER_ID,
      baseUrl,
      api: piMessagesApi(),
      auth: {
        apiKey: {
          name: "AI_GATEWAY_INTERNAL_TOKEN",
          resolve: () => Promise.resolve({ auth: { apiKey: token }, source: "AI_GATEWAY_INTERNAL_TOKEN" }),
        },
      },
      models: [model],
    }),
  );

  return {
    model,
    streamFn: (requestModel, context, options) => {
      const timeout = AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      return models.streamSimple(requestModel, context, { ...options, signal });
    },
  };
}
