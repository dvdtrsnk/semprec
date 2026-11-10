import { createServer, type ServerResponse } from "node:http";
import { register } from "node:module";
import { createModels } from "@earendil-works/pi-ai";
import { z } from "zod";

register(
  new URL("../../../../semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url),
  import.meta.url,
);
const { createPool } = await import("@semprec/data");
const { runAsSystem } = await import("@semprec/shared");
const { createDispatcher } = await import("../../app.js");
const { createOpenAiSpeechSynthesisProvider } = await import("../../audioProviders/openAiSpeechSynthesisProvider.js");
const connectionString = process.env.BATCH32_GATEWAY_DATABASE_URL;
if (!connectionString) throw new Error("Missing fixture database");
const pool = createPool(connectionString);
const role = await runAsSystem("test:speech-gateway-role", () =>
  pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  ),
);
if (role.rows.length !== 1 || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false) {
  throw new Error("Invalid fixture runtime role");
}
const token = "batch32-test-token";
const caps = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };
const controlSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("mode"), mode: z.enum(["normal", "hold", "fail"]) }),
  z.strictObject({ type: z.literal("release") }),
  z.strictObject({ type: z.literal("stop") }),
]);
let mode: "normal" | "hold" | "fail" = "normal";
let calls = 0;
const pending = new Set<ServerResponse>();
const provider = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/speech") {
    res.writeHead(404).end();
    return;
  }
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > 32 * 1024) req.destroy();
  });
  req.on("end", () => {
    calls += 1;
    if (calls > 100) {
      req.destroy();
      return;
    }
    process.send?.({ type: "providerCall", sequence: calls });
    if (mode === "fail") {
      res.writeHead(500).end();
      return;
    }
    if (mode === "hold") {
      pending.add(res);
      res.once("close", () => pending.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(480, 1));
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address();
if (!providerAddress || typeof providerAddress === "string") throw new Error("Missing provider address");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (input !== "https://api.openai.com/v1/audio/speech") throw new Error("Unexpected fixture destination");
  return originalFetch(`http://127.0.0.1:${providerAddress.port}/speech`, init);
};
const unused = (): never => {
  throw new Error("Unexpected fixture operation");
};
const gateway = createServer(
  createDispatcher(
    pool,
    {
      internalToken: token,
      provider: { id: "unused", supportsJsonSchemaStructuredOutput: true, complete: unused },
      model: "unused",
      pricePerMillionInputTokens: 0,
      pricePerMillionOutputTokens: 0,
      globalCaps: caps,
    },
    {
      internalToken: token,
      diarizationProvider: { id: "unused", model: "unused", diarize: unused },
      transcriptionProvider: { id: "unused", model: "unused", transcribe: unused },
      pyannotePricePerAudioHour: 0,
      deepInfraPricePerAudioHour: 0,
      globalCaps: caps,
    },
    { internalToken: token, models: createModels(), apiKey: "unused", globalCaps: caps, streamFn: unused },
    {
      internalToken: token,
      provider: createOpenAiSpeechSynthesisProvider("fixture-key"),
      pricePerAudioHour: 36,
      maxConcurrentStreams: 4,
      globalCaps: caps,
    },
  ),
);
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayAddress = gateway.address();
if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Missing gateway address");
process.send?.({ type: "ready", port: gatewayAddress.port });
let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void (async () => {
    const errors: unknown[] = [];
    const attempt = async (work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const response of pending)
      await attempt(() => {
        response.destroy();
      });
    pending.clear();
    await attempt(() => gateway.closeAllConnections());
    await attempt(() => provider.closeAllConnections());
    await attempt(
      () => new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve()))),
    );
    await attempt(
      () => new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve()))),
    );
    await attempt(() => pool.end());
    await attempt(() => process.disconnect?.());
    if (errors.length) throw new AggregateError(errors, "Speech gateway fixture shutdown failed", { cause: errors[0] });
  })().catch(() => {
    process.stderr.write("Speech gateway fixture shutdown failed\n");
    process.exitCode = 1;
    process.disconnect?.();
  });
}
process.on("message", (message: unknown) => {
  const parsed = controlSchema.safeParse(message);
  if (!parsed.success || JSON.stringify(message).length > 256) {
    process.exitCode = 1;
    shutdown();
    return;
  }
  if (parsed.data.type === "mode") {
    mode = parsed.data.mode;
    process.send?.({ type: "mode", mode });
    return;
  }
  if (parsed.data.type === "release") {
    for (const response of pending) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(480, 1));
    }
    pending.clear();
    process.send?.({ type: "released" });
    return;
  }
  shutdown();
});
process.on("disconnect", shutdown);
