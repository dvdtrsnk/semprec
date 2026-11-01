import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http2 from "node:http2";
import type { Socket } from "node:net";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApnsConfigFromEnv, sendApnsBackgroundPush, sendApnsNotification, type ApnsConfig } from "../apnsAdapter.js";
import type { NotificationPushPayload } from "../pushSenders.js";
import { ValidationError } from "../../errors.js";

const ENV_KEYS = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY_PATH", "APNS_TOPIC"] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("getApnsConfigFromEnv", () => {
  it("reads the private key from APNS_PRIVATE_KEY_PATH, not inline from the environment", () => {
    const keyPath = path.join(os.tmpdir(), `apns-key-${process.pid}-${Date.now()}.p8`);
    const pem = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
    fs.writeFileSync(keyPath, pem);
    try {
      process.env.APNS_TEAM_ID = "team-1";
      process.env.APNS_KEY_ID = "key-1";
      process.env.APNS_PRIVATE_KEY_PATH = keyPath;
      process.env.APNS_TOPIC = "com.example.app";

      expect(getApnsConfigFromEnv()).toEqual({
        teamId: "team-1",
        keyId: "key-1",
        privateKey: pem,
        topic: "com.example.app",
      });
    } finally {
      fs.rmSync(keyPath);
    }
  });

  it("throws when APNS_PRIVATE_KEY_PATH is unset, even if the other three vars are present", () => {
    process.env.APNS_TEAM_ID = "team-1";
    process.env.APNS_KEY_ID = "key-1";
    delete process.env.APNS_PRIVATE_KEY_PATH;
    process.env.APNS_TOPIC = "com.example.app";

    expect(() => getApnsConfigFromEnv()).toThrow(/APNS_PRIVATE_KEY_PATH/);
  });

  it("throws when APNS_PRIVATE_KEY_PATH points at a file that does not exist", () => {
    process.env.APNS_TEAM_ID = "team-1";
    process.env.APNS_KEY_ID = "key-1";
    process.env.APNS_PRIVATE_KEY_PATH = path.join(os.tmpdir(), "does-not-exist.p8");
    process.env.APNS_TOPIC = "com.example.app";

    expect(() => getApnsConfigFromEnv()).toThrow(/ENOENT.*does-not-exist\.p8/);
  });
});

describe("sendApnsNotification (issue #703)", () => {
  const target = { deviceToken: "device-1", apnsEnvironment: "sandbox" as const };
  const payload = { notificationId: "notif-1", title: "Title", body: null, linkHref: null };

  it("resolves not-configured naming the missing variable when APNS_* is unset, without making an HTTP/2 request", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const connectSpy = vi.spyOn(http2, "connect").mockImplementation(() => {
      throw new Error("Unexpected connection");
    });

    const result = await sendApnsNotification(target, payload);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/APNS_TEAM_ID/) });
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });

  it("resolves not-configured with an ENOENT reason when APNS_PRIVATE_KEY_PATH points at a missing file", async () => {
    process.env.APNS_TEAM_ID = "team-1";
    process.env.APNS_KEY_ID = "key-1";
    process.env.APNS_PRIVATE_KEY_PATH = path.join(os.tmpdir(), `apns-key-missing-${process.pid}-${Date.now()}.p8`);
    process.env.APNS_TOPIC = "com.example.app";
    const connectSpy = vi.spyOn(http2, "connect").mockImplementation(() => {
      throw new Error("Unexpected connection");
    });

    const result = await sendApnsNotification(target, payload);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/ENOENT/) });
    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });
});

const apnsTarget = { deviceToken: "device-1", apnsEnvironment: "sandbox" as const };
const apnsTestConfig: ApnsConfig = {
  teamId: "team-1",
  keyId: "key-1",
  privateKey: crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
  topic: "com.example.app",
};

/** One HTTP/2 request as the owned peer received it: its headers and the body it was ended with. */
interface RecordedApnsRequest {
  headers: http2.IncomingHttpHeaders;
  body: string;
}

/** The status and optional `reason` the fake session answers every request with. */
interface FakeApnsAnswer {
  status: number;
  reason?: string;
}

/** The connect stub redirects the real client to a test-owned, cleartext loopback peer. */
async function withApnsPeer<T>(
  answer: FakeApnsAnswer,
  run: (requests: RecordedApnsRequest[]) => Promise<T>,
  afterClose?: () => void,
): Promise<T> {
  const requests: RecordedApnsRequest[] = [];
  const sessions = new Set<http2.ServerHttp2Session>();
  const sockets = new Set<Socket>();
  const server = http2.createServer();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setTimeout(5000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 65536) stream.close(http2.constants.NGHTTP2_CANCEL);
    });
    stream.on("end", () => {
      requests.push({ headers, body });
      stream.respond({ ":status": answer.status });
      stream.end(answer.reason === undefined ? undefined : JSON.stringify({ reason: answer.reason }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let restoreConnect: (() => void) | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  let cleanupFailure: { error: unknown } | undefined;
  function clean(action: () => void): void {
    try {
      action();
    } catch (error) {
      cleanupFailure ??= { error };
    }
  }
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing APNs test peer address");
    const connect = http2.connect.bind(http2);
    const spy = vi.spyOn(http2, "connect").mockImplementation(() => connect(`http://127.0.0.1:${address.port}`));
    restoreConnect = () => spy.mockRestore();
    outcome = { ok: true, value: await run(requests) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    clean(() => restoreConnect?.());
    for (const session of sessions) clean(() => session.destroy());
    for (const socket of sockets) clean(() => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("APNs test peer did not close")), 5000);
        server.close((err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
      afterClose?.();
    } catch (error) {
      cleanupFailure ??= { error };
    }
  }
  if (!outcome.ok) {
    if (cleanupFailure) console.error("APNs test peer cleanup failed after the test failed");
    throw outcome.error;
  }
  if (cleanupFailure) throw cleanupFailure.error;
  return outcome.value;
}

describe("owned APNs peer cleanup", () => {
  it("reports a cleanup failure after closing the peer", async () => {
    const failure = new Error("cleanup-sentinel");
    let closed = false;
    await expect(
      withApnsPeer(
        { status: 200 },
        async () => "ok",
        () => {
          closed = true;
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(closed).toBe(true);
  });

  it("preserves a body failure if cleanup also fails after closing the peer", async () => {
    const failure = new Error("body-sentinel");
    let closed = false;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withApnsPeer(
          { status: 200 },
          async () => {
            throw failure;
          },
          () => {
            closed = true;
            throw new Error("cleanup-secret-sentinel");
          },
        ),
      ).rejects.toBe(failure);
      expect(closed).toBe(true);
      expect(log).toHaveBeenCalledExactlyOnceWith("APNs test peer cleanup failed after the test failed");
    } finally {
      log.mockRestore();
    }
  });
});

describe("sendApnsNotification interruption level (issue #1443)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through the owned peer and returns the result with the JSON body the adapter put on the wire. */
  async function sendAndReadBody(payload: NotificationPushPayload) {
    return withApnsPeer({ status: 200 }, async (requests) => {
      const result = await sendApnsNotification(apnsTarget, payload, apnsTestConfig);
      expect(requests).toHaveLength(1);
      const wire: unknown = JSON.parse(requests[0]!.body);
      return { result, wire };
    });
  }

  it("sends aps interruption-level when the payload carries one", async () => {
    const { result, wire } = await sendAndReadBody({
      notificationId: "notif-1",
      title: "Title",
      body: null,
      linkHref: null,
      interruptionLevel: "time-sensitive",
    });

    expect(result).toEqual({ outcome: "delivered" });
    expect(wire).toEqual({
      aps: { alert: { title: "Title" }, "interruption-level": "time-sensitive" },
      link_href: null,
      notification_id: "notif-1",
    });
  });

  it("leaves interruption-level off the wire when the payload carries none, so APNs uses its default", async () => {
    const { result, wire } = await sendAndReadBody({
      notificationId: "notif-2",
      title: "Title",
      body: null,
      linkHref: null,
    });

    expect(result).toEqual({ outcome: "delivered" });
    expect(wire).toEqual({
      aps: { alert: { title: "Title" } },
      link_href: null,
      notification_id: "notif-2",
    });
  });
});

describe("sendApnsNotification body (issue #1773)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through the owned peer and returns the JSON body the adapter put on the wire. */
  async function sendAndReadWire(payload: NotificationPushPayload): Promise<unknown> {
    return withApnsPeer({ status: 200 }, async (requests) => {
      await sendApnsNotification(apnsTarget, payload, apnsTestConfig);
      expect(requests).toHaveLength(1);
      const wire: unknown = JSON.parse(requests[0]!.body);
      return wire;
    });
  }

  it("sends aps.alert.body beside the title when the notification has a body", async () => {
    const wire = await sendAndReadWire({
      notificationId: "notif-3",
      title: "Semp needs approval",
      body: 'Delete the item "Tax return" in the database "Tasks". This action is irreversible.',
      linkHref: "?page=approvals&user=u1",
    });

    expect(wire).toEqual({
      aps: {
        alert: {
          title: "Semp needs approval",
          body: 'Delete the item "Tax return" in the database "Tasks". This action is irreversible.',
        },
      },
      link_href: "?page=approvals&user=u1",
      notification_id: "notif-3",
    });
  });

  it("leaves aps.alert.body off the wire, not null, when the notification has none", async () => {
    const wire = await sendAndReadWire({ notificationId: "notif-4", title: "Title", body: null, linkHref: null });

    expect(wire).toEqual({ aps: { alert: { title: "Title" } }, link_href: null, notification_id: "notif-4" });
  });
});

describe("sendApnsBackgroundPush (issue #1445)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through the owned peer and returns the result with the exact body and headers the adapter put on the wire. */
  async function sendBackgroundAndRead(data: Record<string, unknown>, answer?: FakeApnsAnswer) {
    return withApnsPeer(answer ?? { status: 200 }, async (requests) => {
      const result = await sendApnsBackgroundPush(apnsTarget, data, apnsTestConfig);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      return { result, body: request.body, headers: request.headers };
    });
  }

  it("sends a sleepResync data object beside aps as a silent background push at priority 5", async () => {
    const { result, body, headers } = await sendBackgroundAndRead({ kind: "sleepResync" });

    expect(result).toEqual({ outcome: "delivered" });
    expect(body).toBe('{"aps":{"content-available":1},"kind":"sleepResync"}');
    expect(headers["apns-push-type"]).toBe("background");
    expect(headers["apns-priority"]).toBe("5");
  });

  it("sends a dismiss list in the payload unchanged, with no alert", async () => {
    const { result, body, headers } = await sendBackgroundAndRead({ dismiss: ["n1"] });

    expect(result).toEqual({ outcome: "delivered" });
    expect(body).toBe('{"aps":{"content-available":1},"dismiss":["n1"]}');
    expect(headers["apns-push-type"]).toBe("background");
    expect(headers["apns-priority"]).toBe("5");
  });

  it("rejects a data object that contains aps with a ValidationError, before any request", async () => {
    const connectSpy = vi.spyOn(http2, "connect").mockImplementation(() => {
      throw new Error("Unexpected connection");
    });

    await expect(
      sendApnsBackgroundPush(apnsTarget, { aps: { alert: "Title" } }, apnsTestConfig),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("maps a 410 answer to permanent-failure", async () => {
    const { result } = await sendBackgroundAndRead({ kind: "sleepResync" }, { status: 410, reason: "Unregistered" });

    expect(result).toEqual({ outcome: "permanent-failure", error: "Unregistered" });
  });

  it("maps a BadDeviceToken answer to permanent-failure", async () => {
    const { result } = await sendBackgroundAndRead({ kind: "sleepResync" }, { status: 400, reason: "BadDeviceToken" });

    expect(result).toEqual({ outcome: "permanent-failure", error: "BadDeviceToken" });
  });

  it("maps any other failed answer to transient-failure", async () => {
    const { result } = await sendBackgroundAndRead(
      { kind: "sleepResync" },
      { status: 500, reason: "InternalServerError" },
    );

    expect(result).toEqual({ outcome: "transient-failure", error: "InternalServerError" });
  });

  it("maps a connection that cannot be opened to transient-failure", async () => {
    const connectError = new Error("ECONNREFUSED");
    vi.spyOn(http2, "connect").mockImplementation(() => {
      throw connectError;
    });

    const result = await sendApnsBackgroundPush(apnsTarget, { kind: "sleepResync" }, apnsTestConfig);

    expect(result).toEqual({ outcome: "transient-failure", error: connectError });
  });

  it("resolves not-configured naming the missing variable when APNS_* is unset, without a request", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const connectSpy = vi.spyOn(http2, "connect").mockImplementation(() => {
      throw new Error("Unexpected connection");
    });

    const result = await sendApnsBackgroundPush(apnsTarget, { kind: "sleepResync" });

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/APNS_TEAM_ID/) });
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("sendApnsNotification push headers (issue #1445)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an alert without the background push-type or priority headers", async () => {
    await withApnsPeer({ status: 200 }, async (requests) => {
      await sendApnsNotification(
        apnsTarget,
        { notificationId: "notif-3", title: "Title", body: null, linkHref: null },
        apnsTestConfig,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers).not.toHaveProperty("apns-push-type");
      expect(requests[0]!.headers).not.toHaveProperty("apns-priority");
    });
  });
});
