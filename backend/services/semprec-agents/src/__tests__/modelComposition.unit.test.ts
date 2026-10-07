import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createGatewayModel } from "../modelComposition.js";

const COMPLETE_ENV = {
  AI_GATEWAY_BASE_URL: "http://127.0.0.1:1/internal/pi",
  AI_GATEWAY_INTERNAL_TOKEN: "internal-token",
  AGENT_MODEL: "agent-model",
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("createGatewayModel (issue #647)", () => {
  it.each(["AI_GATEWAY_BASE_URL", "AI_GATEWAY_INTERNAL_TOKEN", "AGENT_MODEL"])(
    "refuses to build without %s",
    (name) => {
      const env = { ...COMPLETE_ENV, [name]: undefined };
      expect(() => createGatewayModel(env)).toThrow(`${name} is not set`);
    },
  );

  it("sends every model call as POST <AI_GATEWAY_BASE_URL>/messages with the internal token", async () => {
    const requests: { method?: string; url?: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) as unknown });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const usage = {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const events = [
          { type: "start" },
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: "hello" },
          { type: "text_end", contentIndex: 0, content: "hello" },
          { type: "done", reason: "stop", usage },
        ];
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const gateway = createGatewayModel({
      ...COMPLETE_ENV,
      AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
    });
    const reply = await gateway.streamFn(
      gateway.model,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { headers: { "x-semprec-agent-run-id": "run-1" } },
    );
    const message = await reply.result();

    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/internal/pi/messages",
      headers: { authorization: "Bearer internal-token", "x-semprec-agent-run-id": "run-1" },
      body: { model: "agent-model" },
    });
  });

  describe("x-semprec-tenant-id", () => {
    const TENANT_ID = "6f1c0a52-9d1e-4b7e-8c53-2f0e5c1a7b11";
    const OTHER_TENANT_ID = "0b9d3c44-7e51-4a8f-9a16-5d2c8e4f1a77";

    /** Runs one model call with `callerHeaders` inside `scope`, returning the headers the gateway received. */
    async function receivedHeaders(
      scope: (call: () => Promise<unknown>) => Promise<unknown>,
      callerHeaders: Record<string, string>,
    ): Promise<IncomingHttpHeaders> {
      let received: IncomingHttpHeaders | undefined;
      server = createServer((req, res) => {
        received = req.headers;
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const usage = {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          res.end(
            `data: ${JSON.stringify({ type: "start" })}\n\ndata: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`,
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const gateway = createGatewayModel({
        ...COMPLETE_ENV,
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
      });
      await scope(async () => {
        const reply = await gateway.streamFn(
          gateway.model,
          { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
          { headers: callerHeaders },
        );
        await reply.result();
      });
      if (!received) throw new Error("the gateway received no request");
      return received;
    }

    it("sends the ambient tenant scope", async () => {
      const headers = await receivedHeaders((call) => runInTenant(TENANT_ID, call), {});
      expect(headers["x-semprec-tenant-id"]).toBe(TENANT_ID);
    });

    it("replaces a caller-supplied value with the scope's", async () => {
      const headers = await receivedHeaders((call) => runInTenant(TENANT_ID, call), {
        "X-Semprec-Tenant-Id": OTHER_TENANT_ID,
      });
      expect(headers["x-semprec-tenant-id"]).toBe(TENANT_ID);
    });

    it("drops a caller-supplied value outside any scope", async () => {
      const headers = await receivedHeaders((call) => call(), { "x-semprec-tenant-id": OTHER_TENANT_ID });
      expect(headers).not.toHaveProperty("x-semprec-tenant-id");
    });

    it("drops a caller-supplied value in system scope", async () => {
      const headers = await receivedHeaders((call) => runAsSystem("unit test: system scope has no tenant", call), {
        "x-semprec-tenant-id": OTHER_TENANT_ID,
      });
      expect(headers).not.toHaveProperty("x-semprec-tenant-id");
    });
  });
});
