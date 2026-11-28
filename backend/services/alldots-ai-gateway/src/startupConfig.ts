import type { GlobalAiCaps } from "@alldots/ai-gateway";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createAnthropicStructuredProvider } from "./structuredProviders/anthropicProvider.js";
import { createStructuredProviderRegistry, type StructuredCompletionProvider } from "./structuredProviders/types.js";
import type { CompleteHandlerOptions } from "./completeHandler.js";
import type { AudioHandlerOptions } from "./audioHandler.js";
import { createPyannoteDiarizationProvider } from "./audioProviders/pyannoteProvider.js";
import { createDeepInfraWhisperProvider } from "./audioProviders/deepInfraWhisperProvider.js";
import { createOpenAiStreamingTranscriptionProvider } from "./audioProviders/openAiStreamingTranscriptionProvider.js";
import {
  DEFAULT_STT_CHUNK_SECONDS,
  MAX_CONCURRENT_STT_STREAMS,
  type SttStreamHandlerOptions,
} from "./sttStreamHandler.js";
import { createOpenAiSpeechSynthesisProvider } from "./audioProviders/openAiSpeechSynthesisProvider.js";
import { MAX_CONCURRENT_TTS_STREAMS, type TtsStreamHandlerOptions } from "./ttsStreamHandler.js";
import type { PiMessagesHandlerOptions } from "./piMessagesHandler.js";

function buildRegisteredProviders(env: NodeJS.ProcessEnv): StructuredCompletionProvider[] {
  return [createAnthropicStructuredProvider(requireEnv(env, "ANTHROPIC_API_KEY"))];
}

/**
 * Startup fails unless the structured provider and model are set and the provider exists and
 * supports native JSON-Schema output. There is deliberately no default model.
 */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function requireDatabaseUrlFallback(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL (or ALLDOTS_SIDE_DATABASE_URL) is not set");
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
  audioHandlerOptions: AudioHandlerOptions;
  piHandlerOptions: PiMessagesHandlerOptions;
  sttStreamHandlerOptions: SttStreamHandlerOptions;
  ttsStreamHandlerOptions: TtsStreamHandlerOptions;
}

export function resolveStartupConfig(
  env: NodeJS.ProcessEnv,
  registeredProviders: StructuredCompletionProvider[] = buildRegisteredProviders(env),
): StartupConfig {
  // The shared `alldots_side` role (docs/operations/database-roles.md); `DATABASE_URL` is the
  // local-development fallback.
  const databaseUrl = env.ALLDOTS_SIDE_DATABASE_URL ?? requireDatabaseUrlFallback(env);

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

  // Configured, not hardcoded: rate cards change and vary per deployment.
  const pricePerMillionInputTokens = requirePositiveFloat(env, "AI_GATEWAY_STRUCTURED_INPUT_PRICE_PER_MTOK");
  const pricePerMillionOutputTokens = requirePositiveFloat(env, "AI_GATEWAY_STRUCTURED_OUTPUT_PRICE_PER_MTOK");

  const diarizationProvider = createPyannoteDiarizationProvider(requireEnv(env, "PYANNOTEAI_API_KEY"));
  const transcriptionProvider = createDeepInfraWhisperProvider(requireEnv(env, "DEEPINFRA_API_KEY"));
  const pyannotePricePerAudioHour = requirePositiveFloat(env, "AI_GATEWAY_PYANNOTE_PRICE_PER_AUDIO_HOUR");
  const deepInfraPricePerAudioHour = requirePositiveFloat(env, "AI_GATEWAY_DEEPINFRA_PRICE_PER_AUDIO_HOUR");

  const sttPricePerAudioHour = requirePositiveFloat(env, "AI_GATEWAY_OPENAI_STT_PRICE_PER_AUDIO_HOUR");
  const sttChunkSeconds =
    env.AI_GATEWAY_STT_CHUNK_SECONDS === undefined
      ? DEFAULT_STT_CHUNK_SECONDS
      : requirePositiveFloat(env, "AI_GATEWAY_STT_CHUNK_SECONDS");

  const ttsPricePerAudioHour = requirePositiveFloat(env, "AI_GATEWAY_OPENAI_TTS_PRICE_PER_AUDIO_HOUR");

  // Required, so a deploy cannot run without a global cap.
  const globalCaps: GlobalAiCaps = {
    dailyCapUsd: requirePositiveFloat(env, "AI_GLOBAL_DAILY_CAP_USD"),
    monthlyCapUsd: requirePositiveFloat(env, "AI_GLOBAL_MONTHLY_CAP_USD"),
  };

  return {
    port,
    databaseUrl,
    handlerOptions: {
      internalToken,
      provider,
      model,
      pricePerMillionInputTokens,
      pricePerMillionOutputTokens,
      globalCaps,
    },
    audioHandlerOptions: {
      internalToken,
      diarizationProvider,
      transcriptionProvider,
      pyannotePricePerAudioHour,
      deepInfraPricePerAudioHour,
      globalCaps,
    },
    piHandlerOptions: {
      internalToken,
      models: builtinModels(),
      apiKey: requireEnv(env, "ANTHROPIC_API_KEY"),
      // `streamSimple`, not `stream`: the pi-messages `reasoning` level is a provider-neutral
      // option that only the simple entry point maps onto Anthropic's thinking parameters.
      streamFn: streamSimple,
      globalCaps,
    },
    sttStreamHandlerOptions: {
      internalToken,
      provider: createOpenAiStreamingTranscriptionProvider(requireEnv(env, "OPENAI_API_KEY")),
      pricePerAudioHour: sttPricePerAudioHour,
      chunkSeconds: sttChunkSeconds,
      maxConcurrentStreams: MAX_CONCURRENT_STT_STREAMS,
      globalCaps,
    },
    ttsStreamHandlerOptions: {
      internalToken,
      provider: createOpenAiSpeechSynthesisProvider(requireEnv(env, "OPENAI_API_KEY")),
      pricePerAudioHour: ttsPricePerAudioHour,
      maxConcurrentStreams: MAX_CONCURRENT_TTS_STREAMS,
      globalCaps,
    },
  };
}
