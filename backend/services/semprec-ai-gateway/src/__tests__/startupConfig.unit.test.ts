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
  ANTHROPIC_API_KEY: "anthropic-key",
  AI_GATEWAY_PYANNOTE_PRICE_PER_AUDIO_HOUR: "1",
  AI_GATEWAY_DEEPINFRA_PRICE_PER_AUDIO_HOUR: "1",
  AI_GLOBAL_DAILY_CAP_USD: "25",
  AI_GLOBAL_MONTHLY_CAP_USD: "400.5",
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
    expect(() => resolveStartupConfig({ ...BASE_ENV }, [FAKE_PROVIDER])).toThrow(
      /DATABASE_URL \(or SEMPREC_SIDE_DATABASE_URL\) is not set/,
    );
  });
});

describe("resolveStartupConfig pi-messages handler options", () => {
  it("wires the internal token, ANTHROPIC_API_KEY and pi-ai's built-in Anthropic catalog", () => {
    const config = resolveStartupConfig({ ...BASE_ENV, DATABASE_URL: "postgres://legacy" }, [FAKE_PROVIDER]);
    expect(config.piHandlerOptions.internalToken).toBe("token");
    expect(config.piHandlerOptions.apiKey).toBe("anthropic-key");
    expect(config.piHandlerOptions.models.getModels("anthropic").length).toBeGreaterThan(0);
  });

  it("throws when ANTHROPIC_API_KEY is not set", () => {
    const { ANTHROPIC_API_KEY: _omitted, ...env } = BASE_ENV;
    expect(() => resolveStartupConfig({ ...env, DATABASE_URL: "postgres://legacy" }, [FAKE_PROVIDER])).toThrow(
      /ANTHROPIC_API_KEY is not set/,
    );
  });
});

describe("resolveStartupConfig global caps", () => {
  const env = { ...BASE_ENV, DATABASE_URL: "postgres://legacy" };

  it("puts the parsed caps into all three handler options", () => {
    const config = resolveStartupConfig(env, [FAKE_PROVIDER]);
    const expected = { dailyCapUsd: 25, monthlyCapUsd: 400.5 };
    expect(config.handlerOptions.globalCaps).toEqual(expected);
    expect(config.audioHandlerOptions.globalCaps).toEqual(expected);
    expect(config.piHandlerOptions.globalCaps).toEqual(expected);
  });

  it.each(["AI_GLOBAL_DAILY_CAP_USD", "AI_GLOBAL_MONTHLY_CAP_USD"])("throws naming %s when it is missing", (name) => {
    const { [name]: _omitted, ...rest } = env;
    expect(() => resolveStartupConfig(rest, [FAKE_PROVIDER])).toThrow(new RegExp(`${name} is not set`));
  });

  it.each([
    ["AI_GLOBAL_DAILY_CAP_USD", "0"],
    ["AI_GLOBAL_DAILY_CAP_USD", "-5"],
    ["AI_GLOBAL_DAILY_CAP_USD", "lots"],
    ["AI_GLOBAL_MONTHLY_CAP_USD", "0"],
    ["AI_GLOBAL_MONTHLY_CAP_USD", "-5"],
    ["AI_GLOBAL_MONTHLY_CAP_USD", "lots"],
  ])("throws naming %s when it is %j", (name, value) => {
    expect(() => resolveStartupConfig({ ...env, [name]: value }, [FAKE_PROVIDER])).toThrow(
      new RegExp(`${name} must be a positive number`),
    );
  });
});
