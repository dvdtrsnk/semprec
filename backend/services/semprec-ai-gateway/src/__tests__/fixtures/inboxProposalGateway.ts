import { createServer } from "node:http";
import { register } from "node:module";
import { z } from "zod";

register(
  new URL("../../../../semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url),
  import.meta.url,
);
const { createPool } = await import("@semprec/data");
const { runAsSystem } = await import("@semprec/shared");
const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
const { createDispatcher } = await import("../../app.js");
const { createAnthropicStructuredProvider } = await import("../../structuredProviders/anthropicProvider.js");

const databaseUrl = process.env.BATCH32_GATEWAY_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing fixture database");
const pool = createPool(databaseUrl);
const role = await runAsSystem("test:inbox-gateway-role", () =>
  pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  ),
);
if (role.rows.length !== 1 || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false)
  throw new Error("Invalid fixture runtime role");

const token = "batch32-inbox-test-token";
const caps = { dailyCapUsd: 1_000_000, monthlyCapUsd: 1_000_000 };
const controls = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("configure"),
    mode: z.enum(["v2", "legacy", "invalid", "unmatched", "missingHeading", "accent", "start", "end", "pageBlock"]),
    target: z.string().uuid(),
  }),
  z.strictObject({ type: z.literal("stop") }),
]);
let configuration: z.infer<typeof controls> | undefined;
let calls = 0;
const provider = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/messages" || !configuration) {
    response.writeHead(400).end();
    return;
  }
  const selected = configuration;
  if (selected.type !== "configure") throw new Error("Missing fixture configuration");
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) request.destroy();
  });
  request.on("end", () => {
    calls += 1;
    if (calls > 20) {
      request.destroy();
      return;
    }
    const payload = z.object({ system: z.string(), tools: z.array(z.object({ input_schema: z.unknown() })) }).safeParse(
      (() => {
        try {
          const value: unknown = JSON.parse(body);
          return value;
        } catch {
          return null;
        }
      })(),
    );
    if (!payload.success) {
      response.writeHead(400).end();
      return;
    }
    const schema = JSON.stringify(payload.data.tools[0]?.input_schema ?? null);
    process.send?.({
      type: "observation",
      sequence: calls,
      v2Instructions: payload.data.system.includes("afterHeadingText") && payload.data.system.includes("markdown"),
      v2Schema: schema.includes("afterHeadingText") && schema.includes("markdown"),
    });
    const properties =
      selected.mode === "legacy"
        ? { flavour: "paragraph", fields: { content: "Fixture legacy" } }
        : {
            markdown:
              selected.mode === "invalid"
                ? ""
                : selected.mode === "pageBlock"
                  ? "[Page](semprec://page/abc)"
                  : "Fixture page text",
            placement:
              selected.mode === "start" || selected.mode === "end"
                ? selected.mode
                : {
                    afterHeadingText:
                      selected.mode === "unmatched" || selected.mode === "missingHeading"
                        ? "Missing"
                        : selected.mode === "accent"
                          ? "dlažba"
                          : "tiles",
                  },
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: [{ type: "tool_use", name: "emit_structured_output", input: { target: selected.target, properties } }],
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address();
if (!providerAddress || typeof providerAddress === "string") throw new Error("Missing provider address");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages")
    throw new Error("Unexpected fixture destination");
  return originalFetch(`http://127.0.0.1:${providerAddress.port}${url.pathname}${url.search}`, init);
};
const unused = (): never => {
  throw new Error("Unexpected fixture operation");
};
const gateway = createServer(
  createDispatcher(
    pool,
    {
      internalToken: token,
      provider: createAnthropicStructuredProvider("fixture-key"),
      model: "claude-haiku-4-5",
      pricePerMillionInputTokens: 1,
      pricePerMillionOutputTokens: 1,
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
    { internalToken: token, models: builtinModels(), apiKey: "unused", globalCaps: caps, streamFn: unused },
  ),
);
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const address = gateway.address();
if (!address || typeof address === "string") throw new Error("Missing gateway address");
process.send?.({ type: "ready", port: address.port });
let stopping = false;
const deadline = setTimeout(() => {
  process.exitCode = 1;
  shutdown();
}, 45_000);
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  gateway.closeAllConnections();
  provider.closeAllConnections();
  void (async () => {
    const results = await Promise.allSettled([
      new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve()))),
      new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve()))),
    ]);
    globalThis.fetch = originalFetch;
    try {
      await pool.end();
    } catch {
      process.exitCode = 1;
    }
    if (results.some((result) => result.status === "rejected")) process.exitCode = 1;
    process.disconnect?.();
  })();
}
process.on("message", (message: unknown) => {
  const encoded = JSON.stringify(message);
  if (typeof encoded !== "string" || encoded.length > 256) {
    process.exitCode = 1;
    shutdown();
    return;
  }
  const parsed = controls.safeParse(message);
  if (!parsed.success) {
    process.exitCode = 1;
    shutdown();
    return;
  }
  if (parsed.data.type === "stop") {
    shutdown();
    return;
  }
  configuration = parsed.data;
  process.send?.({ type: "configured", mode: parsed.data.mode });
});
process.on("disconnect", shutdown);
