import { createECDH, randomBytes } from "node:crypto";
import http, { type Server } from "node:http";
import https from "node:https";
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OutboundAddressNotAllowedError,
  allowLoopbackOutboundForTests,
  createOutboundHttp,
  isOutboundAddressNotAllowed,
  isPublicAddress,
  type OutboundAddressPolicy,
} from "../net/outboundAddressPolicy.js";
import { sendWebPushNotification } from "../push/webPushAdapter.js";
import { stubDnsLookup, type DnsLookupStub } from "../testSupport/dnsLookupStub.js";

/** A local HTTP server that records every TCP connection and request path it receives. */
interface CountingServer {
  readonly port: number;
  readonly requests: string[];
  connectionCount(): number;
  stop(): Promise<void>;
}

async function startCountingServer(): Promise<CountingServer> {
  const requests: string[] = [];
  const server: Server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("counting server has no port");
  return {
    port: address.port,
    requests,
    connectionCount: () => connections,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let stub: DnsLookupStub | undefined;
let server: CountingServer;

beforeEach(async () => {
  server = await startCountingServer();
});

afterEach(async () => {
  stub?.restore();
  stub = undefined;
  await server.stop();
});

/** The public-only address rule over `http:`, so the refusal under test is the resolved address, not the protocol. */
const PUBLIC_ONLY_OVER_HTTP: OutboundAddressPolicy = {
  isTestPolicy: false,
  protocols: ["http:"],
  allowsResolvedAddress: isPublicAddress,
  allowsIpLiteral: () => false,
};

describe("createOutboundHttp().fetch against a real server (issue #1034)", () => {
  it("refuses a hostname resolving to loopback without the server receiving a request", async () => {
    stub = stubDnsLookup({ "loopback.test": ["127.0.0.1"] });
    const outbound = createOutboundHttp(PUBLIC_ONLY_OVER_HTTP);
    try {
      const error = await outbound.fetch(`http://loopback.test:${server.port}/`).catch((err: unknown) => err);
      expect(isOutboundAddressNotAllowed(error)).toBe(true);
    } finally {
      await outbound.close();
    }
    expect(stub.calls).toEqual(["loopback.test"]);
    expect(server.connectionCount()).toBe(0);
  });

  it("connects to the vetted address when the policy allows it", async () => {
    stub = stubDnsLookup({ "loopback.test": ["127.0.0.1"] });
    const restore = allowLoopbackOutboundForTests();
    const outbound = createOutboundHttp();
    try {
      const response = await outbound.fetch(`http://loopback.test:${server.port}/hello`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await outbound.close();
      restore();
    }
    expect(server.requests).toEqual(["/hello"]);
  });

  it("does not follow a 302 from an allowed server", async () => {
    const restore = allowLoopbackOutboundForTests();
    const outbound = createOutboundHttp();
    try {
      await expect(outbound.fetch(`http://127.0.0.1:${server.port}/redirect`)).rejects.toThrow();
    } finally {
      await outbound.close();
      restore();
    }
    expect(server.requests).toEqual(["/redirect"]);
  });
});

describe("sendWebPushNotification under the default policy (issue #1034)", () => {
  const vapid = webpush.generateVAPIDKeys();
  const config = { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: "mailto:ops@example.test" };
  const payload = { notificationId: "notif-1", title: "Title", linkHref: null };

  function subscription(endpoint: string) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return {
      endpoint,
      p256dh: ecdh.getPublicKey().toString("base64url"),
      authSecret: randomBytes(16).toString("base64url"),
    };
  }

  it("returns permanent-failure for an endpoint whose host resolves to a private address", async () => {
    stub = stubDnsLookup({ "push.internal.test": ["10.0.0.5"] });
    const result = await sendWebPushNotification(subscription("https://push.internal.test/send/1"), payload, config);
    expect(result.outcome).toBe("permanent-failure");
    expect(result.outcome === "permanent-failure" && isOutboundAddressNotAllowed(result.error)).toBe(true);
    expect(stub.calls).toEqual(["push.internal.test"]);
  });

  it("returns permanent-failure for a loopback host without the local server receiving a request", async () => {
    // `https:` to the counting server's port: the address is refused before any TLS handshake would start.
    stub = stubDnsLookup({ "push.loopback.test": ["127.0.0.1"] });
    const result = await sendWebPushNotification(
      subscription(`https://push.loopback.test:${server.port}/send/1`),
      payload,
      config,
    );
    expect(result.outcome).toBe("permanent-failure");
    expect(server.connectionCount()).toBe(0);
  });

  it("returns permanent-failure for an IP-literal endpoint", async () => {
    const result = await sendWebPushNotification(subscription("https://10.0.0.5/send/1"), payload, config);
    expect(result).toEqual({ outcome: "permanent-failure", error: expect.any(OutboundAddressNotAllowedError) });
  });

  it("keeps the decided outcome when tearing down the per-send pool fails", async () => {
    const destroy = vi.spyOn(https.Agent.prototype, "destroy").mockImplementation(() => {
      throw new Error("pool teardown failed");
    });
    try {
      const result = await sendWebPushNotification(subscription("https://10.0.0.5/send/1"), payload, config);
      expect(result).toEqual({ outcome: "permanent-failure", error: expect.any(OutboundAddressNotAllowedError) });
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
  });
});
