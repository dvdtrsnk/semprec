import { createAnthropicStructuredProvider } from "./structuredProviders/anthropicProvider.js";
import { createStructuredProviderRegistry, type StructuredCompletionProvider } from "./structuredProviders/types.js";
import type { CompleteHandlerOptions } from "./completeHandler.js";

/** Every provider this deployment of `semprec-ai-gateway` knows how to construct, keyed by id. */
function buildRegisteredProviders(env: NodeJS.ProcessEnv): StructuredCompletionProvider[] {
  return [createAnthropicStructuredProvider(requireEnv(env, "ANTHROPIC_API_KEY"))];
}

/**
 * #215: "startup requires non-empty `AI_GATEWAY_STRUCTURED_PROVIDER` and
 * `AI_GATEWAY_STRUCTURED_MODEL`; the provider id must exist in the gateway provider registry and
 * advertise native JSON-Schema structured output, otherwise startup fails. There is deliberately
 * no silent/default model." This function is the single place that enforces all of that, so
 * `serve.ts` stays a thin wiring script and tests can exercise the same validation without
 * booting a real HTTP server.
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function requirePositiveFloat(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requireEnv(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got: ${raw}`);
  return value;
}

export interface StartupConfig {
  port: number;
  databaseUrl: string;
  handlerOptions: CompleteHandlerOptions;
}

export function resolveStartupConfig(
  env: NodeJS.ProcessEnv,
  registeredProviders: StructuredCompletionProvider[] = buildRegisteredProviders(env),
): StartupConfig {
  const databaseUrl = requireEnv(env, "DATABASE_URL");

  const rawPort = env.AI_GATEWAY_PORT ?? "3002";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`AI_GATEWAY_PORT is not a valid port number: ${rawPort}`);

  const internalToken = requireEnv(env, "AI_GATEWAY_INTERNAL_TOKEN");
  const providerId = requireEnv(env, "AI_GATEWAY_STRUCTURED_PROVIDER");
  const model = requireEnv(env, "AI_GATEWAY_STRUCTURED_MODEL");

  const registry = createStructuredProviderRegistry(registeredProviders);
  const provider = registry.get(providerId);
  if (!provider) {
    throw new Error(`AI_GATEWAY_STRUCTURED_PROVIDER "${providerId}" is not a registered provider`);
  }
  if (!provider.supportsJsonSchemaStructuredOutput) {
    throw new Error(
      `AI_GATEWAY_STRUCTURED_PROVIDER "${providerId}" does not advertise native JSON-Schema structured output`,
    );
  }

  // Pricing is read from configuration rather than a hardcoded table: provider rate cards change
  // over time and vary per deployment, and guessing a figure here would silently mis-price every
  // `ai_gateway_calls` row this route ever writes.
  const pricePerMillionInputTokens = requirePositiveFloat(env, "AI_GATEWAY_STRUCTURED_INPUT_PRICE_PER_MTOK");
  const pricePerMillionOutputTokens = requirePositiveFloat(env, "AI_GATEWAY_STRUCTURED_OUTPUT_PRICE_PER_MTOK");

  return {
    port,
    databaseUrl,
    handlerOptions: {
      internalToken,
      provider,
      model,
      pricePerMillionInputTokens,
      pricePerMillionOutputTokens,
    },
  };
}
