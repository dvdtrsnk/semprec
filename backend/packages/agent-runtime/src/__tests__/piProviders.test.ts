import { describe, expect, it } from "vitest";
import { registerPiProviders, type PiProviderRegistry } from "../piProviders.js";

function createFakePi(): PiProviderRegistry & { calls: Array<{ name: string; baseUrl: string }> } {
  const calls: Array<{ name: string; baseUrl: string }> = [];
  return {
    calls,
    registerProvider(name, config) {
      calls.push({ name, baseUrl: config.baseUrl });
    },
  };
}

describe("registerPiProviders", () => {
  it("registers the gateway baseUrl for anthropic and openai", () => {
    const pi = createFakePi();

    registerPiProviders(pi, "https://gateway.internal");

    expect(pi.calls).toEqual([
      { name: "anthropic", baseUrl: "https://gateway.internal" },
      { name: "openai", baseUrl: "https://gateway.internal" },
    ]);
  });
});
