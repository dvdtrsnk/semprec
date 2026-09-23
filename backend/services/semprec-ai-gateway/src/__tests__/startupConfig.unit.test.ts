import { describe, expect, it } from "vitest";
import { resolveStartupConfig } from "../startupConfig.js";
import type { StructuredCompletionProvider } from "../structuredProviders/types.js";

const FAKE_PROVIDER: StructuredCompletionProvider = {
  id: "anthropic",
  supportsJsonSchemaStructuredOutput: true,
  complete: async () => ({ content: {}, inputTokens: 0, outputTokens: 0 }),
};

const BASE_ENV: NodeJS.ProcessEnv = {
  AI_GATEWAY_INTERNAL_TOKEN: "token",
  AI_GATEWAY_STRUCTURED_PROVIDER: "anthropic",
  AI_GATEWAY_STRUCTURED_MODEL: "claude-sonnet-5",
  AI_GATEWAY_STRUCTURED_INPUT_PRICE_PER_MTOK: "1",
  AI_GATEWAY_STRUCTURED_OUTPUT_PRICE_PER_MTOK: "1",
  PYANNOTEAI_API_KEY: "pyannote-key",
  DEEPINFRA_API_KEY: "deepinfra-key",
  AI_GATEWAY_PYANNOTE_PRICE_PER_AUDIO_HOUR: "1",
  AI_GATEWAY_DEEPINFRA_PRICE_PER_AUDIO_HOUR: "1",
};

describe("resolveStartupConfig database url resolution", () => {
  it("prefers SEMPREC_SIDE_DATABASE_URL over DATABASE_URL when both are set", () => {
    const config = resolveStartupConfig(
      { ...BASE_ENV, SEMPREC_SIDE_DATABASE_URL: "postgres://side", DATABASE_URL: "postgres://legacy" },
      [FAKE_PROVIDER],
    );
    expect(config.databaseUrl).toBe("postgres://side");
  });

  it("falls back to DATABASE_URL for local development when SEMPREC_SIDE_DATABASE_URL is unset", () => {
    const config = resolveStartupConfig({ ...BASE_ENV, DATABASE_URL: "postgres://legacy" }, [FAKE_PROVIDER]);
    expect(config.databaseUrl).toBe("postgres://legacy");
  });

  it("throws when neither SEMPREC_SIDE_DATABASE_URL nor DATABASE_URL is set", () => {
    expect(() => resolveStartupConfig({ ...BASE_ENV }, [FAKE_PROVIDER])).toThrow(/DATABASE_URL is not set/);
  });
});
