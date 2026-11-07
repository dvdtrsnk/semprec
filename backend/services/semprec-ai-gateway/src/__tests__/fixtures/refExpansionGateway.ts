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
const { streamSimple } = await import("@earendil-works/pi-ai/compat");
const { createDispatcher } = await import("../../app.js");

const databaseUrl = process.env.BATCH32_GATEWAY_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing fixture database");
const pool = createPool(databaseUrl);
const role = await runAsSystem("test:ref-gateway-role", () =>
  pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  ),
);
if (role.rows.length !== 1 || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false)
  throw new Error("Invalid fixture runtime role");

const token = "batch32-ref-test-token";
const model = "claude-haiku-4-5";
const caps = { dailyCapUsd: 1_000_000, monthlyCapUsd: 1_000_000 };
let calls = 0;
const provider = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) request.destroy();
  });
  request.on("end", () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const pending: unknown[] = [parsed];
    const mimeTypes = new Set<string>();
    let imageCount = 0;
    let nodes = 0;
    while (pending.length) {
      const value = pending.pop();
      if (++nodes > 100_000) {
        response.writeHead(400).end();
        return;
      }
      if (Array.isArray(value)) {
        if (pending.length + value.length > 100_000) {
          response.writeHead(400).end();
          return;
        }
        for (const child of value) pending.push(child);
      } else if (typeof value === "object" && value !== null) {
        if ("type" in value && value.type === "image") {
          if (
            !("source" in value) ||
            typeof value.source !== "object" ||
            value.source === null ||
            !("media_type" in value.source) ||
            typeof value.source.media_type !== "string" ||
            !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(value.source.media_type)
          ) {
            response.writeHead(400).end();
            return;
          }
          imageCount += 1;
          mimeTypes.add(value.source.media_type);
        }
        const children: unknown[] = Object.values(value);
        if (pending.length + children.length > 100_000) {
          response.writeHead(400).end();
          return;
        }
        for (const child of children) pending.push(child);
      }
    }
    calls += 1;
    if (calls > 20) {
      request.destroy();
      return;
    }
    process.send?.({
      type: "observation",
      sequence: calls,
      owner: body.includes("REF_OWNER_SENTINEL_32"),
      foreign: body.includes("REF_FOREIGN_SENTINEL_32"),
      mailFirst: body.includes("REF_MAIL_FIRST_SENTINEL_32"),
      mailReply: body.includes("REF_MAIL_REPLY_SENTINEL_32"),
      block: body.includes("REF_BLOCK_SENTINEL_32"),
      sibling: body.includes("REF_SIBLING_SENTINEL_32"),
      imageCount,
      imageMimes: [...mimeTypes].sort(),
      providerSerializedBytes: Buffer.byteLength(body),
    });
    const events = [
      {
        type: "message_start",
        message: {
          id: "fixture-message",
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture response." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
if (!address || typeof address === "string") throw new Error("Missing provider address");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages")
    throw new Error("Unexpected fixture destination");
  return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
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
    { internalToken: token, models: builtinModels(), apiKey: "fixture-key", streamFn: streamSimple, globalCaps: caps },
  ),
);
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayAddress = gateway.address();
if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Missing gateway address");
process.send?.({ type: "ready", port: gatewayAddress.port });
let stopping = false;
const deadline = setTimeout(() => {
  process.exitCode = 1;
  shutdown();
}, 90_000);
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
const control = z.strictObject({ type: z.literal("stop") });
process.on("message", (message: unknown) => {
  if (!control.safeParse(message).success || JSON.stringify(message).length > 128) process.exitCode = 1;
  shutdown();
});
process.on("disconnect", shutdown);
