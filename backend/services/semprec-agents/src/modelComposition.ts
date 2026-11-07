import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { currentTenantScope } from "@semprec/shared";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";

const GATEWAY_PROVIDER_ID = "semprec-ai-gateway";

/** Carries the run's tenant scope to the gateway, which validates it and enters that tenant. */
const TENANT_ID_HEADER = "x-semprec-tenant-id";

/**
 * Upper bound on one model call, SSE stream included: the gateway is a local process, but one
 * that accepts the request and then stops answering must not hold an agent run open forever.
 */
const GATEWAY_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** The header the gateway adds to a refusal so a caller can tell its cause without reading the body. */
const ERROR_CODE_HEADER = "x-semprec-error-code";
const BUDGET_EXCEEDED_CODE = "budget_exceeded";
const MAX_GATEWAY_PAYLOAD_BYTES = 4 * 1024 * 1024;
const IMAGE_OMITTED = "[image omitted: request size limit]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Bounds the actual JSON payload without modifying the session's in-memory history. */
export function boundGatewayImagePayload(input: unknown): unknown {
  const encoded = JSON.stringify(input);
  if (encoded === undefined) throw new Error("Invalid gateway request payload");
  if (Buffer.byteLength(encoded, "utf8") < MAX_GATEWAY_PAYLOAD_BYTES) return input;
  const copy: unknown = JSON.parse(encoded);
  if (!isRecord(copy) || !isRecord(copy.context) || !isUnknownArray(copy.context.messages))
    throw new Error("Gateway request exceeds the size limit");
  for (const message of copy.context.messages) {
    if (!isRecord(message) || !isUnknownArray(message.content)) continue;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      if (!isRecord(block) || block.type !== "image") continue;
      message.content[index] = { type: "text", text: IMAGE_OMITTED };
      if (Buffer.byteLength(JSON.stringify(copy), "utf8") < MAX_GATEWAY_PAYLOAD_BYTES) return copy;
    }
  }
  throw new Error("Gateway request exceeds the size limit");
}

export interface GatewayModel {
  model: Model<Api>;
  streamFn: StreamFn;
  /**
   * Whether this assistant message is the final message of a `streamFn` call that the gateway
   * refused with `403` and `x-semprec-error-code: budget_exceeded`. False for any other message.
   */
  isBudgetRefusal: (message: AssistantMessage) => boolean;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
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
    input: ["text", "image"],
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

  // Final messages of calls the gateway refused for the budget, keyed by the message object itself:
  // the capture is per call (a local in `streamFn`), never a variable shared between sessions.
  const budgetRefusals = new WeakSet<AssistantMessage>();

  return {
    model,
    isBudgetRefusal: (message) => budgetRefusals.has(message),
    streamFn: (requestModel, context, options) => {
      const timeout = AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      // The scope read now wins over any caller-supplied value; outside a tenant scope the header is dropped.
      const headers = Object.fromEntries(
        Object.entries(options?.headers ?? {}).filter(([name]) => name.toLowerCase() !== TENANT_ID_HEADER),
      );
      const scope = currentTenantScope();
      if (scope?.kind === "tenant") headers[TENANT_ID_HEADER] = scope.tenantId;
      let budgetRefused = false;
      const stream = models.streamSimple(requestModel, context, {
        ...options,
        headers,
        signal,
        onPayload: async (payload, payloadModel) => {
          const changed = await options?.onPayload?.(payload, payloadModel);
          return boundGatewayImagePayload(changed === undefined ? payload : changed);
        },
        onResponse: async (response, responseModel) => {
          budgetRefused =
            response.status === 403 && headerValue(response.headers, ERROR_CODE_HEADER) === BUDGET_EXCEEDED_CODE;
          await options?.onResponse?.(response, responseModel);
        },
      });
      // `result()` resolves, never rejects. Registered before the caller can await it, so the
      // message is marked by the time the caller sees it.
      void stream.result().then((message) => {
        if (budgetRefused && message.stopReason === "error") budgetRefusals.add(message);
      });
      return stream;
    },
  };
}
