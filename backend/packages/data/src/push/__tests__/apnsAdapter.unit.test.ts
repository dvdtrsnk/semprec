import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http2 from "node:http2";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
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
  const payload = { notificationId: "notif-1", title: "Title", linkHref: null };

  it("resolves not-configured naming the missing variable when APNS_* is unset, without making an HTTP/2 request", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const connectSpy = vi.spyOn(http2, "connect");

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

    const result = await sendApnsNotification(target, payload);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/ENOENT/) });
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

/** One HTTP/2 request as the fake session received it: its headers and the body it was ended with. */
interface RecordedApnsRequest {
  headers: http2.OutgoingHttpHeaders;
  body: string;
}

/** The status and optional `reason` the fake session answers every request with. */
interface FakeApnsAnswer {
  status: number;
  reason?: string;
}

/** One HTTP/2 request's stand-in: records its headers and body when ended, then gives `answer`. */
class FakeApnsStream extends EventEmitter {
  private readonly requests: RecordedApnsRequest[];
  private readonly headers: http2.OutgoingHttpHeaders;
  private readonly answer: FakeApnsAnswer;

  constructor(requests: RecordedApnsRequest[], headers: http2.OutgoingHttpHeaders, answer: FakeApnsAnswer) {
    super();
    this.requests = requests;
    this.headers = headers;
    this.answer = answer;
  }

  setEncoding(): void {}

  end(body: string): void {
    this.requests.push({ headers: this.headers, body });
    queueMicrotask(() => {
      this.emit("response", { ":status": this.answer.status });
      if (this.answer.reason !== undefined) this.emit("data", JSON.stringify({ reason: this.answer.reason }));
      this.emit("end");
    });
  }
}

/** The HTTP/2 session the adapter connects; every request it sends is kept in `requests`. */
class FakeApnsSession extends EventEmitter {
  readonly requests: RecordedApnsRequest[] = [];
  private readonly answer: FakeApnsAnswer;

  constructor(answer: FakeApnsAnswer = { status: 200 }) {
    super();
    this.answer = answer;
  }

  request(headers: http2.OutgoingHttpHeaders): FakeApnsStream {
    return new FakeApnsStream(this.requests, headers, this.answer);
  }

  close(): void {}

  destroy(): void {}
}

describe("sendApnsNotification interruption level (issue #1443)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through a fake session and returns the result with the JSON body the adapter put on the wire. */
  async function sendAndReadBody(payload: NotificationPushPayload) {
    const session = new FakeApnsSession();
    // The adapter uses only request, close, destroy and on, which the fake provides.
    vi.spyOn(http2, "connect").mockImplementation(() => session as unknown as http2.ClientHttp2Session);

    const result = await sendApnsNotification(apnsTarget, payload, apnsTestConfig);

    expect(session.requests).toHaveLength(1);
    const wire: unknown = JSON.parse(session.requests[0]!.body);
    return { result, wire };
  }

  it("sends aps interruption-level when the payload carries one", async () => {
    const { result, wire } = await sendAndReadBody({
      notificationId: "notif-1",
      title: "Title",
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
    const { result, wire } = await sendAndReadBody({ notificationId: "notif-2", title: "Title", linkHref: null });

    expect(result).toEqual({ outcome: "delivered" });
    expect(wire).toEqual({
      aps: { alert: { title: "Title" } },
      link_href: null,
      notification_id: "notif-2",
    });
  });
});

describe("sendApnsBackgroundPush (issue #1445)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through a fake session and returns the result with the exact body and headers the adapter put on the wire. */
  async function sendBackgroundAndRead(data: Record<string, unknown>, answer?: FakeApnsAnswer) {
    const session = new FakeApnsSession(answer);
    vi.spyOn(http2, "connect").mockImplementation(() => session as unknown as http2.ClientHttp2Session);

    const result = await sendApnsBackgroundPush(apnsTarget, data, apnsTestConfig);

    expect(session.requests).toHaveLength(1);
    const request = session.requests[0]!;
    return { result, body: request.body, headers: request.headers };
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
    const session = new FakeApnsSession();
    const connectSpy = vi
      .spyOn(http2, "connect")
      .mockImplementation(() => session as unknown as http2.ClientHttp2Session);

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
    const session = new FakeApnsSession();
    const connectSpy = vi
      .spyOn(http2, "connect")
      .mockImplementation(() => session as unknown as http2.ClientHttp2Session);

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
    const session = new FakeApnsSession();
    vi.spyOn(http2, "connect").mockImplementation(() => session as unknown as http2.ClientHttp2Session);

    await sendApnsNotification(
      apnsTarget,
      { notificationId: "notif-3", title: "Title", linkHref: null },
      apnsTestConfig,
    );

    expect(session.requests).toHaveLength(1);
    const headers = session.requests[0]!.headers;
    expect(headers).not.toHaveProperty("apns-push-type");
    expect(headers).not.toHaveProperty("apns-priority");
  });
});
