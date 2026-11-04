import { createServer } from "node:http";
import { register } from "node:module";
import { createModels } from "@earendil-works/pi-ai";

register(
  new URL("../../../../semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url),
  import.meta.url,
);
const { createPool } = await import("@semprec/data");
const { createDispatcher } = await import("../../app.js");
const { createDeepInfraWhisperProvider } = await import("../../audioProviders/deepInfraWhisperProvider.js");
const runtimeUrl = process.env.BATCH22_GATEWAY_DATABASE_URL;
if (!runtimeUrl) throw new Error("Missing gateway fixture database");
const pool = createPool(runtimeUrl);
const token = "batch22-test-token";
const caps = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };
const provider = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text: "hello", language: "czech", segments: [{ start: 0, end: 0.4, text: "hello" }] }));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
if (!address || typeof address === "string") throw new Error("Missing fixture provider address");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (input !== "https://api.deepinfra.com/v1/openai/audio/transcriptions" || !(init?.body instanceof FormData))
    throw new Error("Unexpected outbound gateway request");
  const language = init.body.get("language");
  if (language !== null && typeof language !== "string") throw new Error("Invalid language fixture input");
  process.send?.({ type: "providerRequest", language });
  return originalFetch(`http://127.0.0.1:${address.port}/`, init);
};
const gateway = createServer(
  createDispatcher(
    pool,
    {
      internalToken: token,
      provider: {
        id: "unused",
        supportsJsonSchemaStructuredOutput: true,
        async complete() {
          throw new Error("Unexpected completion");
        },
      },
      model: "unused",
      pricePerMillionInputTokens: 0,
      pricePerMillionOutputTokens: 0,
      globalCaps: caps,
    },
    {
      internalToken: token,
      diarizationProvider: {
        id: "local",
        model: "local",
        async diarize() {
          process.send?.({ type: "diarize" });
          return [{ speaker: "SPEAKER_00", start: 0, end: 1 }];
        },
      },
      transcriptionProvider: createDeepInfraWhisperProvider("fixture-key"),
      pyannotePricePerAudioHour: 0,
      deepInfraPricePerAudioHour: 0,
      globalCaps: caps,
    },
    {
      internalToken: token,
      models: createModels(),
      apiKey: "unused",
      globalCaps: caps,
      streamFn: () => {
        throw new Error("Unexpected stream");
      },
    },
  ),
);
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayAddress = gateway.address();
if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Missing gateway address");
process.send?.({ type: "ready", port: gatewayAddress.port });
process.on("message", (message: unknown) => {
  if (message !== "stop") return;
  void (async () => {
    await new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
    await pool.end();
    process.disconnect?.();
  })().catch(() => {
    process.stderr.write("Gateway fixture shutdown failed\n");
    process.exit(1);
  });
});
