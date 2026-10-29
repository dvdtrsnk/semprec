import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http2 from "node:http2";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApnsConfigFromEnv, sendApnsNotification, type ApnsConfig } from "../apnsAdapter.js";
import type { NotificationPushPayload } from "../pushSenders.js";

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

/** One HTTP/2 request's stand-in: records the body it is ended with, then answers 200. */
class FakeApnsStream extends EventEmitter {
  private readonly bodies: string[];

  constructor(bodies: string[]) {
    super();
    this.bodies = bodies;
  }

  setEncoding(): void {}

  end(body: string): void {
    this.bodies.push(body);
    queueMicrotask(() => {
      this.emit("response", { ":status": 200 });
      this.emit("end");
    });
  }
}

/** The HTTP/2 session the adapter connects; every request body it sends is kept in `bodies`. */
class FakeApnsSession extends EventEmitter {
  readonly bodies: string[] = [];

  request(): FakeApnsStream {
    return new FakeApnsStream(this.bodies);
  }

  close(): void {}

  destroy(): void {}
}

describe("sendApnsNotification interruption level (issue #1443)", () => {
  const privateKey = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const config: ApnsConfig = { teamId: "team-1", keyId: "key-1", privateKey, topic: "com.example.app" };
  const target = { deviceToken: "device-1", apnsEnvironment: "sandbox" as const };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Sends through a fake session and returns the result with the JSON body the adapter put on the wire. */
  async function sendAndReadBody(payload: NotificationPushPayload) {
    const session = new FakeApnsSession();
    // The adapter uses only request, close, destroy and on, which the fake provides.
    vi.spyOn(http2, "connect").mockImplementation(() => session as unknown as http2.ClientHttp2Session);

    const result = await sendApnsNotification(target, payload, config);

    expect(session.bodies).toHaveLength(1);
    const wire: unknown = JSON.parse(session.bodies[0]!);
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
