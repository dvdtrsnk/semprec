import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http2 from "node:http2";
import type { Socket } from "node:net";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apnsCollapseKey,
  getApnsConfigFromEnv,
  sendApnsBackgroundPush,
  sendApnsBadgeUpdate,
  sendApnsNotification,
  type ApnsConfig,
} from "../apnsAdapter.js";
import type { NotificationPushPayload } from "../pushSenders.js";
import { ValidationError } from "../../errors.js";

/** The source fields of a notification whose source has no durable identity (issue #1829), so no collapse key. */
const NO_IDENTITY_SOURCE = {
  sourceTable: "project_heartbeats",
  sourceId: "heartbeat-1",
  kind: "heartbeat_error",
} as const;

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
  const payload = { notificationId: "notif-1", ...NO_IDENTITY_SOURCE, title: "Title", body: null, linkHref: null };

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
      ...NO_IDENTITY_SOURCE,
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
      ...NO_IDENTITY_SOURCE,
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
      ...NO_IDENTITY_SOURCE,
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
    const wire = await sendAndReadWire({
      notificationId: "notif-4",
      ...NO_IDENTITY_SOURCE,
      title: "Title",
      body: null,
      linkHref: null,
    });

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

describe("apnsCollapseKey (issue #1829)", () => {
  const requestId = "0c7e3a52-6a41-4e0d-8f0b-2f1a5f0d9b11";

  it.each(["semp_problems", "approval_requests", "invites"])("is the source id of a %s source", (sourceTable) => {
    expect(apnsCollapseKey({ sourceTable, sourceId: requestId })).toBe(requestId);
  });

  it("is null for a source table without a durable identity", () => {
    expect(apnsCollapseKey({ sourceTable: "project_heartbeats", sourceId: requestId })).toBeNull();
  });

  it("is null for an empty source id, whatever the source table", () => {
    expect(apnsCollapseKey({ sourceTable: "approval_requests", sourceId: "" })).toBeNull();
  });

  it("keeps a source id of exactly 64 bytes", () => {
    const sourceId = "a".repeat(64);

    expect(apnsCollapseKey({ sourceTable: "semp_problems", sourceId })).toBe(sourceId);
  });

  it("replaces a source id longer than 64 bytes by the first 64 hex characters of its SHA-256", () => {
    const sourceId = "a".repeat(65);
    const expected = crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 64);

    const key = apnsCollapseKey({ sourceTable: "semp_problems", sourceId });

    expect(key).toBe(expected);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(apnsCollapseKey({ sourceTable: "semp_problems", sourceId })).toBe(key);
  });

  it("counts bytes, not characters, so 33 two-byte characters are shortened", () => {
    const sourceId = "é".repeat(33);

    const key = apnsCollapseKey({ sourceTable: "invites", sourceId });

    expect(key).toBe(crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 64));
  });

  it("gives different long source ids different keys", () => {
    const first = apnsCollapseKey({ sourceTable: "semp_problems", sourceId: "b".repeat(100) });
    const second = apnsCollapseKey({ sourceTable: "semp_problems", sourceId: "c".repeat(100) });

    expect(first).not.toBe(second);
  });
});

describe("sendApnsNotification push headers and thread id (issues #1445 and #1829)", () => {
  const SENT_AT = new Date("2026-11-12T10:00:00.000Z");
  const EXPIRES_AT = String(Math.floor(SENT_AT.getTime() / 1000) + 24 * 60 * 60);

  beforeEach(() => {
    // Only the clock: the owned HTTP/2 peer needs the real timers.
    vi.useFakeTimers({ toFake: ["Date"], now: SENT_AT });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Sends one alert through the owned peer and returns the headers and the JSON body the adapter put on the wire. */
  async function sendAndRead(payload: NotificationPushPayload) {
    return withApnsPeer({ status: 200 }, async (requests) => {
      const result = await sendApnsNotification(apnsTarget, payload, apnsTestConfig);
      expect(result).toEqual({ outcome: "delivered" });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      const wire: unknown = JSON.parse(request.body);
      return { headers: request.headers, wire };
    });
  }

  it("sends the collapse id and the thread id of an approval request, equal to the request id", async () => {
    const requestId = "5d2f0d6e-2f4b-4a0c-9a43-0d1d3a8d7a10";

    const { headers, wire } = await sendAndRead({
      notificationId: "notif-approval",
      title: "Semp needs approval",
      body: "Delete the item.",
      linkHref: "?page=approvals",
      interruptionLevel: "time-sensitive",
      sourceTable: "approval_requests",
      sourceId: requestId,
      kind: "approval_pending",
    });

    expect(headers["apns-collapse-id"]).toBe(requestId);
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-expiration"]).toBe(EXPIRES_AT);
    expect(wire).toEqual({
      aps: {
        alert: { title: "Semp needs approval", body: "Delete the item." },
        "interruption-level": "time-sensitive",
        "thread-id": requestId,
      },
      link_href: "?page=approvals",
      notification_id: "notif-approval",
    });
  });

  it("sends the collapse id and the thread id of a Semp problem, equal to the problem id", async () => {
    const problemId = "9b0a6f3c-7e36-4d52-8a0f-1f5d4f9a2c21";

    const { headers, wire } = await sendAndRead({
      notificationId: "notif-problem",
      title: "Mail sync stalled",
      body: null,
      linkHref: null,
      sourceTable: "semp_problems",
      sourceId: problemId,
      kind: "semp_problem",
    });

    expect(headers["apns-collapse-id"]).toBe(problemId);
    expect(wire).toEqual({
      aps: { alert: { title: "Mail sync stalled" }, "thread-id": problemId },
      link_href: null,
      notification_id: "notif-problem",
    });
  });

  it("sends the shortened key in both places when the source id is longer than 64 bytes", async () => {
    const sourceId = "d".repeat(100);
    const key = crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 64);

    const { headers, wire } = await sendAndRead({
      notificationId: "notif-long",
      title: "Title",
      body: null,
      linkHref: null,
      sourceTable: "invites",
      sourceId,
      kind: "approval_pending",
    });

    expect(headers["apns-collapse-id"]).toBe(key);
    expect(wire).toEqual({
      aps: { alert: { title: "Title" }, "thread-id": key },
      link_href: null,
      notification_id: "notif-long",
    });
  });

  it("sends neither a collapse id nor a thread id for a kind without a durable source identity", async () => {
    const { headers, wire } = await sendAndRead({
      notificationId: "notif-none",
      ...NO_IDENTITY_SOURCE,
      title: "Title",
      body: null,
      linkHref: null,
    });

    expect(headers).not.toHaveProperty("apns-collapse-id");
    expect(wire).toEqual({ aps: { alert: { title: "Title" } }, link_href: null, notification_id: "notif-none" });
    // The rest of the alert contract holds without an identity.
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-expiration"]).toBe(EXPIRES_AT);
  });

  it("sends neither for a durable source table with an empty source id", async () => {
    const { headers, wire } = await sendAndRead({
      notificationId: "notif-empty",
      title: "Title",
      body: null,
      linkHref: null,
      sourceTable: "approval_requests",
      sourceId: "",
      kind: "approval_pending",
    });

    expect(headers).not.toHaveProperty("apns-collapse-id");
    expect(wire).toEqual({ aps: { alert: { title: "Title" } }, link_href: null, notification_id: "notif-empty" });
  });

  it("expires a push 24 hours after the moment it is sent", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:30:00.000Z"));

    const { headers } = await sendAndRead({
      notificationId: "notif-later",
      ...NO_IDENTITY_SOURCE,
      title: "Title",
      body: null,
      linkHref: null,
    });

    expect(headers["apns-expiration"]).toBe(String(Date.parse("2027-01-01T23:30:00.000Z") / 1000));
  });
});

describe("sendApnsNotification approval fields (issue #1831)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends one alert through the owned peer and returns the headers and the JSON body the adapter put on the wire. */
  async function sendAndRead(payload: NotificationPushPayload) {
    return withApnsPeer({ status: 200 }, async (requests) => {
      const result = await sendApnsNotification(apnsTarget, payload, apnsTestConfig);
      expect(result).toEqual({ outcome: "delivered" });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      const wire: unknown = JSON.parse(request.body);
      return { headers: request.headers, wire };
    });
  }

  const requestId = "5d2f0d6e-2f4b-4a0c-9a43-0d1d3a8d7a10";
  const approvalPayload: NotificationPushPayload = {
    notificationId: "notif-approval",
    title: "Semp needs approval",
    body: 'Call the tool "search_web" on the MCP server "Search". This action is irreversible.',
    linkHref: "?page=approvals",
    interruptionLevel: "time-sensitive",
    sourceTable: "approval_requests",
    sourceId: requestId,
    kind: "approval_pending",
  };

  it("sends aps.category, a time-sensitive interruption level, the body and the request id of an approval", async () => {
    const { headers, wire } = await sendAndRead({
      ...approvalPayload,
      apns: { category: "APPROVAL_REQUEST", approvalRequestId: requestId },
    });

    expect(wire).toEqual({
      aps: {
        alert: { title: "Semp needs approval", body: approvalPayload.body },
        "interruption-level": "time-sensitive",
        "thread-id": requestId,
        category: "APPROVAL_REQUEST",
      },
      link_href: "?page=approvals",
      notification_id: "notif-approval",
      approvalRequestId: requestId,
    });
    // The collapse id and the thread id are the ones of issue #1829 and stay the request id.
    expect(headers["apns-collapse-id"]).toBe(requestId);
  });

  it("sends neither a category nor a request id when the payload carries no apns fields", async () => {
    const { wire } = await sendAndRead(approvalPayload);

    expect(wire).not.toHaveProperty("approvalRequestId");
    expect(wire).not.toHaveProperty("aps.category");
  });

  it("sends neither when the apns fields are empty", async () => {
    const { wire } = await sendAndRead({ ...approvalPayload, apns: {} });

    expect(wire).not.toHaveProperty("approvalRequestId");
    expect(wire).not.toHaveProperty("aps.category");
  });

  it("sends the category without a request id when only the category is set", async () => {
    const { wire } = await sendAndRead({ ...approvalPayload, apns: { category: "APPROVAL_REQUEST" } });

    expect(wire).toHaveProperty("aps.category", "APPROVAL_REQUEST");
    expect(wire).not.toHaveProperty("approvalRequestId");
  });

  it("sends the request id without a category when only the request id is set", async () => {
    const { wire } = await sendAndRead({ ...approvalPayload, apns: { approvalRequestId: requestId } });

    expect(wire).toHaveProperty("approvalRequestId", requestId);
    expect(wire).not.toHaveProperty("aps.category");
  });

  it("puts nothing of the request but its id and the rendered body on the wire", async () => {
    const { wire } = await sendAndRead({
      ...approvalPayload,
      apns: { category: "APPROVAL_REQUEST", approvalRequestId: requestId },
    });

    const serialized = JSON.stringify(wire);
    expect(Object.keys(wire as object).sort()).toEqual(["approvalRequestId", "aps", "link_href", "notification_id"]);
    expect(serialized).not.toMatch(/args|payload|resourceSnapshot|description/i);
  });
});

describe("sendApnsBackgroundPush headers (issue #1829)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays a background push without a collapse id, an expiration or the alert push type", async () => {
    await withApnsPeer({ status: 200 }, async (requests) => {
      await sendApnsBackgroundPush(apnsTarget, { dismiss: ["n1"] }, apnsTestConfig);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers["apns-push-type"]).toBe("background");
      expect(requests[0]!.headers["apns-priority"]).toBe("5");
      expect(requests[0]!.headers).not.toHaveProperty("apns-collapse-id");
      expect(requests[0]!.headers).not.toHaveProperty("apns-expiration");
    });
  });
});

describe("sendApnsNotification badge (issue #1891)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through the owned peer and returns the `aps` object the adapter put on the wire. */
  async function sendAndReadAps(payload: NotificationPushPayload): Promise<unknown> {
    return withApnsPeer({ status: 200 }, async (requests) => {
      await sendApnsNotification(apnsTarget, payload, apnsTestConfig);
      expect(requests).toHaveLength(1);
      const wire: unknown = JSON.parse(requests[0]!.body);
      return typeof wire === "object" && wire !== null && "aps" in wire ? wire.aps : undefined;
    });
  }

  const base = { notificationId: "notif-b", ...NO_IDENTITY_SOURCE, title: "Title", body: null, linkHref: null };

  it("sends aps.badge beside the alert when the payload carries a badge", async () => {
    expect(await sendAndReadAps({ ...base, badge: 3 })).toEqual({ alert: { title: "Title" }, badge: 3 });
  });

  it("sends aps.badge 0, which clears the badge, instead of leaving it out", async () => {
    expect(await sendAndReadAps({ ...base, badge: 0 })).toEqual({ alert: { title: "Title" }, badge: 0 });
  });

  it("leaves aps.badge off the wire when the payload carries none", async () => {
    expect(await sendAndReadAps(base)).toEqual({ alert: { title: "Title" } });
  });
});

describe("sendApnsBadgeUpdate (issue #1891)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through the owned peer and returns the result with the exact body and headers the adapter put on the wire. */
  async function sendBadgeAndRead(badge: number, answer?: FakeApnsAnswer) {
    return withApnsPeer(answer ?? { status: 200 }, async (requests) => {
      const result = await sendApnsBadgeUpdate(apnsTarget, badge, apnsTestConfig);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      return { result, body: request.body, headers: request.headers };
    });
  }

  it("sends a payload of only aps.badge, with no alert and no sound", async () => {
    const { result, body } = await sendBadgeAndRead(3);

    expect(result).toEqual({ outcome: "delivered" });
    expect(body).toBe('{"aps":{"badge":3}}');
    expect(body).not.toMatch(/alert|sound|content-available/);
  });

  it("sends badge 0, which clears the badge", async () => {
    const { body } = await sendBadgeAndRead(0);

    expect(body).toBe('{"aps":{"badge":0}}');
  });

  it("sends the alert push type at priority 5 with the collapse id badge, so it does not wake the app", async () => {
    const { headers } = await sendBadgeAndRead(2);

    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("5");
    expect(headers["apns-collapse-id"]).toBe("badge");
    expect(headers["apns-topic"]).toBe("com.example.app");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the badge %s with a ValidationError, before any request",
    async (badge) => {
      const connectSpy = vi.spyOn(http2, "connect").mockImplementation(() => {
        throw new Error("Unexpected connection");
      });

      await expect(sendApnsBadgeUpdate(apnsTarget, badge, apnsTestConfig)).rejects.toBeInstanceOf(ValidationError);
      expect(connectSpy).not.toHaveBeenCalled();
    },
  );

  it("maps a 410 answer to permanent-failure", async () => {
    const { result } = await sendBadgeAndRead(1, { status: 410, reason: "Unregistered" });

    expect(result).toEqual({ outcome: "permanent-failure", error: "Unregistered" });
  });

  it("maps a BadDeviceToken answer to permanent-failure", async () => {
    const { result } = await sendBadgeAndRead(1, { status: 400, reason: "BadDeviceToken" });

    expect(result).toEqual({ outcome: "permanent-failure", error: "BadDeviceToken" });
  });

  it("maps any other failed answer to transient-failure", async () => {
    const { result } = await sendBadgeAndRead(1, { status: 503, reason: "ServiceUnavailable" });

    expect(result).toEqual({ outcome: "transient-failure", error: "ServiceUnavailable" });
  });

  it("resolves not-configured naming the missing variable when APNS_* is unset, without a request", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const connectSpy = vi.spyOn(http2, "connect").mockImplementation(() => {
      throw new Error("Unexpected connection");
    });

    const result = await sendApnsBadgeUpdate(apnsTarget, 1);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/APNS_TEAM_ID/) });
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
