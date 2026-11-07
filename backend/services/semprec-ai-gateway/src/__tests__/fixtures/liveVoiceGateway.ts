import { createServer, type ServerResponse } from "node:http";
import { register } from "node:module";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

register(
  new URL("../../../../semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url),
  import.meta.url,
);
const { createPool } = await import("@semprec/data");
const { runAsSystem } = await import("@semprec/shared");
const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
const { streamSimple } = await import("@earendil-works/pi-ai/compat");
const { createDispatcher, createUpgradeDispatcher } = await import("../../app.js");
const { createSttStreamUpgradeHandler } = await import("../../sttStreamHandler.js");
const { createOpenAiStreamingTranscriptionProvider } =
  await import("../../audioProviders/openAiStreamingTranscriptionProvider.js");
const { createOpenAiSpeechSynthesisProvider } = await import("../../audioProviders/openAiSpeechSynthesisProvider.js");
const databaseUrl = process.env.BATCH32_GATEWAY_DATABASE_URL;
if (!databaseUrl) throw new Error("Missing fixture database");
const pool = createPool(databaseUrl);
const role = await runAsSystem("test:voice-gateway-role", () =>
  pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
  ),
);
if (role.rows.length !== 1 || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false)
  throw new Error("Invalid fixture runtime role");
const token = "batch32-test-token";
const caps = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };
const control = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("partial") }),
  z.strictObject({ type: z.literal("final") }),
  z.strictObject({ type: z.literal("finalSecond") }),
  z.strictObject({ type: z.literal("holdSpeech") }),
  z.strictObject({ type: z.literal("releaseSpeech") }),
  z.strictObject({ type: z.literal("holdModel") }),
  z.strictObject({ type: z.literal("releaseModel") }),
  z.strictObject({ type: z.literal("approvalTarget"), itemId: z.string().uuid() }),
  z.strictObject({ type: z.literal("stop") }),
]);
const providerSockets = new Set<WebSocket>();
const pending = new Set<ServerResponse>();
const pendingModel = new Set<ServerResponse>();
const approvalByResponse = new Map<ServerResponse, string>();
let approvalTarget: string | undefined;
let holdSpeech = false;
let holdModel = false;
let speechCalls = 0;
let modelCalls = 0;
const model = "claude-haiku-4-5";
function sse(event: object & { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
function endModel(res: ServerResponse): void {
  const target = approvalByResponse.get(res);
  approvalByResponse.delete(res);
  const toolEvents = target
    ? [
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "voice-approval-call", name: "item_delete", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ itemId: target }) },
        },
        { type: "content_block_stop", index: 1 },
      ]
    : [];
  res.end(
    [
      { type: "content_block_stop", index: 0 },
      ...toolEvents,
      {
        type: "message_delta",
        delta: { stop_reason: target ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ]
      .map(sse)
      .join(""),
  );
}
const provider = createServer((req, res) => {
  if (req.method !== "POST" || (req.url !== "/speech" && req.url !== "/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  const modelRequest = req.url === "/v1/messages";
  let bytes = 0;
  req.on("data", (part: Buffer) => {
    bytes += part.length;
    if (bytes > (modelRequest ? 4 * 1024 * 1024 : 32 * 1024)) req.destroy();
  });
  req.on("end", () => {
    if (modelRequest) {
      if (++modelCalls > 100) {
        req.destroy();
        return;
      }
      process.send?.({ type: "modelCall", sequence: modelCalls });
      if (approvalTarget) {
        approvalByResponse.set(res, approvalTarget);
        approvalTarget = undefined;
        res.once("close", () => approvalByResponse.delete(res));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        [
          {
            type: "message_start",
            message: {
              id: "voice-fixture",
              type: "message",
              role: "assistant",
              content: [],
              model,
              stop_reason: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First sentence. " } },
        ]
          .map(sse)
          .join(""),
      );
      if (holdModel) {
        pendingModel.add(res);
        res.once("close", () => pendingModel.delete(res));
      } else endModel(res);
      return;
    }
    if (++speechCalls > 100) {
      req.destroy();
      return;
    }
    process.send?.({ type: "speechCall", sequence: speechCalls });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.alloc(480, 1));
    if (holdSpeech) {
      pending.add(res);
      res.once("close", () => pending.delete(res));
    } else res.end(Buffer.alloc(480, 2));
  });
});
const providerWs = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
provider.on("upgrade", (req, socket, head) => {
  if (req.url !== "/stt") {
    socket.destroy();
    return;
  }
  providerWs.handleUpgrade(req, socket, head, (ws) => {
    providerSockets.add(ws);
    ws.once("close", () => providerSockets.delete(ws));
    ws.on("error", () => {});
    ws.on("message", (data, binary) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (binary || bytes.length > 128 * 1024) {
        ws.terminate();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        ws.terminate();
        return;
      }
      if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
        ws.terminate();
        return;
      }
      if (value.type === "transcription_session.update") process.send?.({ type: "sttReady" });
      else if (value.type === "input_audio_buffer.append") process.send?.({ type: "audioAccepted" });
      else if (value.type === "input_audio_buffer.commit")
        ws.send(JSON.stringify({ type: "error", error: { code: "input_audio_buffer_commit_empty" } }));
      else ws.terminate();
    });
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address();
if (!providerAddress || typeof providerAddress === "string") throw new Error("Missing provider address");
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  let target: string;
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/audio/speech")
    target = `http://127.0.0.1:${providerAddress.port}/speech`;
  else if (url.origin === "https://api.anthropic.com" && url.pathname === "/v1/messages")
    target = `http://127.0.0.1:${providerAddress.port}/v1/messages${url.search}`;
  else throw new Error("Unexpected fixture destination");
  return originalFetch(input instanceof Request ? new Request(target, input) : target, init);
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
    { internalToken: token, models: builtinModels(), apiKey: "fixture-key", globalCaps: caps, streamFn: streamSimple },
    {
      internalToken: token,
      provider: createOpenAiSpeechSynthesisProvider("fixture-key"),
      pricePerAudioHour: 36,
      maxConcurrentStreams: 4,
      globalCaps: caps,
    },
  ),
);
const stt = createSttStreamUpgradeHandler(pool, {
  internalToken: token,
  provider: createOpenAiStreamingTranscriptionProvider("fixture-key", (url, options) => {
    if (url !== "wss://api.openai.com/v1/realtime?intent=transcription")
      throw new Error("Unexpected fixture destination");
    return new WebSocket(`ws://127.0.0.1:${providerAddress.port}/stt`, options);
  }),
  pricePerAudioHour: 36,
  chunkSeconds: 30,
  maxConcurrentStreams: 4,
  globalCaps: caps,
});
gateway.on("upgrade", createUpgradeDispatcher(stt));
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const address = gateway.address();
if (!address || typeof address === "string") throw new Error("Missing gateway address");
process.send?.({ type: "ready", port: address.port });
let stopping = false;
const deadline = setTimeout(() => {
  process.exitCode = 1;
  shutdown();
}, 120_000);
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  void (async () => {
    const errors: unknown[] = [];
    const attempt = async (work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => stt.closeAll());
    for (const res of pending)
      await attempt(() => {
        res.destroy();
      });
    for (const res of pendingModel)
      await attempt(() => {
        res.destroy();
      });
    for (const ws of providerSockets) await attempt(() => ws.terminate());
    await attempt(() => gateway.closeAllConnections());
    await attempt(() => provider.closeAllConnections());
    await attempt(
      () => new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve()))),
    );
    await attempt(
      () => new Promise<void>((resolve, reject) => providerWs.close((error) => (error ? reject(error) : resolve()))),
    );
    await attempt(
      () => new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve()))),
    );
    await attempt(() => pool.end());
    await attempt(() => process.disconnect?.());
    if (errors.length) throw new AggregateError(errors, "Voice gateway fixture shutdown failed", { cause: errors[0] });
  })().catch(() => {
    process.stderr.write("Voice gateway fixture shutdown failed\n");
    process.exitCode = 1;
    process.disconnect?.();
  });
}
process.on("message", (value: unknown) => {
  const parsed = control.safeParse(value);
  if (!parsed.success || JSON.stringify(value).length > 128) {
    process.exitCode = 1;
    shutdown();
    return;
  }
  switch (parsed.data.type) {
    case "partial":
    case "final":
    case "finalSecond": {
      const partial = parsed.data.type === "partial";
      const text = parsed.data.type === "finalSecond" ? "A second question." : "A spoken question.";
      for (const ws of providerSockets)
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify(
              partial
                ? { type: "conversation.item.input_audio_transcription.delta", item_id: "fixture", delta: text }
                : {
                    type: "conversation.item.input_audio_transcription.completed",
                    item_id: "fixture",
                    transcript: text,
                  },
            ),
          );
      break;
    }
    case "holdSpeech":
      holdSpeech = true;
      break;
    case "releaseSpeech":
      for (const res of pending) res.end(Buffer.alloc(480, 2));
      pending.clear();
      holdSpeech = false;
      break;
    case "holdModel":
      holdModel = true;
      break;
    case "releaseModel":
      for (const res of pendingModel) endModel(res);
      pendingModel.clear();
      holdModel = false;
      break;
    case "approvalTarget":
      if (approvalTarget) {
        process.exitCode = 1;
        shutdown();
        break;
      }
      approvalTarget = parsed.data.itemId;
      process.send?.({ type: "approvalReady" });
      break;
    case "stop":
      shutdown();
      break;
  }
});
process.on("disconnect", shutdown);
