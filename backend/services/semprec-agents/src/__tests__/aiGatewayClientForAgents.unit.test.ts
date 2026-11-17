import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAiGatewayClientForAgents } from "../actionRegistryComposition.js";

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** A stand-in for `POST /internal/complete` of the gateway that keeps the request it was sent. */
async function listenAsGateway(): Promise<{ port: number; requests: { url: string; authorization: string }[] }> {
  const requests: { url: string; authorization: string }[] = [];
  server = createServer((req: IncomingMessage, res) => {
    requests.push({ url: req.url ?? "", authorization: String(req.headers.authorization ?? "") });
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: { expectsReply: true }, usage: { inputTokens: 1, outputTokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { port: (server?.address() as AddressInfo).port, requests };
}

describe("createAiGatewayClientForAgents (issue gh-1941)", () => {
  it("refuses to build a client without the internal token", () => {
    expect(() => createAiGatewayClientForAgents({})).toThrow("AI_GATEWAY_INTERNAL_TOKEN is not set");
    expect(() => createAiGatewayClientForAgents({ AI_GATEWAY_INTERNAL_TOKEN: "" })).toThrow(
      "AI_GATEWAY_INTERNAL_TOKEN is not set",
    );
  });

  it("calls /internal/complete of the gateway on the configured port with the internal token", async () => {
    const { port, requests } = await listenAsGateway();
    const client = createAiGatewayClientForAgents({
      AI_GATEWAY_INTERNAL_TOKEN: "secret",
      AI_GATEWAY_PORT: String(port),
    });

    const result = await client.complete({
      projectItemId: null,
      operation: "mailAnswerExpected",
      temperature: 0,
      system: "s",
      messages: [{ role: "user", content: "m" }],
      responseSchema: { type: "object" },
    });

    expect(result.content).toEqual({ expectsReply: true });
    expect(requests).toEqual([{ url: "/internal/complete", authorization: "Bearer secret" }]);
  });
});
