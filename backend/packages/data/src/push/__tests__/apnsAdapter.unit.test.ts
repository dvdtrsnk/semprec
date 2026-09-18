import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getApnsConfigFromEnv } from "../apnsAdapter.js";

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

    expect(() => getApnsConfigFromEnv()).toThrow();
  });
});
