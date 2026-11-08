import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { boundGatewayImagePayload, createGatewayModel } from "../modelComposition.js";

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
  it("declares both text and image input to pi", () => {
    expect(createGatewayModel(COMPLETE_ENV).model.input).toEqual(["text", "image"]);
  });

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

  describe("budget refusal capture", () => {
    const REQUEST = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

    async function listenWith(handler: (url: string, res: import("node:http").ServerResponse) => void) {
      server = createServer((req, res) => {
        req.resume();
        req.on("end", () => handler(req.headers["x-case"] as string, res));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      return createGatewayModel({ ...COMPLETE_ENV, AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi` });
    }

    const refuse =
      (status: number, headers: Record<string, string>) => (_c: string, res: import("node:http").ServerResponse) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify({ error: "AI budget exceeded", code: "budget_exceeded" }));
      };

    async function finalMessage(gateway: Awaited<ReturnType<typeof listenWith>>, headers: Record<string, string> = {}) {
      const reply = await gateway.streamFn(gateway.model, REQUEST, { headers, maxRetries: 0 });
      return reply.result();
    }

    it("recognizes a 403 with the budget header, compared case-insensitively", async () => {
      const gateway = await listenWith(refuse(403, { "X-Semprec-Error-Code": "budget_exceeded" }));
      const message = await finalMessage(gateway);
      expect(message.stopReason).toBe("error");
      expect(gateway.isBudgetRefusal(message)).toBe(true);
    });

    it.each([
      ["a 403 without the header", 403, {}],
      ["a 403 with another code", 403, { "x-semprec-error-code": "other" }],
      ["a 400 with the budget header", 400, { "x-semprec-error-code": "budget_exceeded" }],
      ["a 500", 500, {}],
    ])("does not recognize %s", async (_name, status, headers) => {
      const gateway = await listenWith(refuse(status, headers));
      const message = await finalMessage(gateway);
      expect(message.stopReason).toBe("error");
      expect(gateway.isBudgetRefusal(message)).toBe(false);
    });

    it("marks only the refused call when two run concurrently", async () => {
      const pending: { which: string; res: import("node:http").ServerResponse }[] = [];
      const gateway = await listenWith((which, res) => {
        const deadline = setTimeout(() => res.destroy(), 3000);
        res.once("close", () => clearTimeout(deadline));
        pending.push({ which, res });
        if (pending.length !== 2) return;
        for (const request of pending) {
          if (request.which === "refuse") {
            refuse(403, { "x-semprec-error-code": "budget_exceeded" })("", request.res);
          } else {
            refuse(500, {})("", request.res);
          }
        }
      });
      const [refused, failed] = await Promise.all([
        finalMessage(gateway, { "x-case": "refuse" }),
        finalMessage(gateway, { "x-case": "fail" }),
      ]);
      expect(pending.map(({ which }) => which).sort()).toEqual(["fail", "refuse"]);
      expect(gateway.isBudgetRefusal(refused)).toBe(true);
      expect(gateway.isBudgetRefusal(failed)).toBe(false);
    });
  });
});

describe("serialized gateway image budget", () => {
  it("replaces the oldest image first without mutating the original or unrelated payload", () => {
    const first = { type: "image", data: "a".repeat(2_100_000), mimeType: "image/jpeg" };
    const second = { type: "image", data: "b".repeat(2_100_000), mimeType: "image/jpeg" };
    const input = {
      model: "test",
      context: {
        systemPrompt: "System",
        tools: [{ name: "tool" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "First" }, first] },
          { role: "user", content: [{ type: "text", text: "Second" }, second] },
        ],
      },
      options: { temperature: 0.2 },
    };
    const output = boundGatewayImagePayload(input);
    expect(output).toEqual({
      ...input,
      context: {
        ...input.context,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "First" },
              { type: "text", text: "[image omitted: request size limit]" },
            ],
          },
          input.context.messages[1],
        ],
      },
    });
    expect(input.context.messages[0]?.content[1]).toBe(first);
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(4 * 1024 * 1024);
  });

  it("refuses an oversized non-image body using UTF-8 bytes", () => {
    expect(() =>
      boundGatewayImagePayload({ context: { messages: [{ role: "user", content: "😀".repeat(1_048_576) }] } }),
    ).toThrow("Gateway request exceeds the size limit");
  });
});
