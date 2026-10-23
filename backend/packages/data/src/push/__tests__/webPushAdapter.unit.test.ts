import webpush from "web-push";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebPushNotification } from "../webPushAdapter.js";

const ENV_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.restoreAllMocks();
});

describe("sendWebPushNotification (issue #703)", () => {
  const target = { endpoint: "https://push.example/web-1", p256dh: "p256dh-key", authSecret: "auth-secret" };
  const payload = { notificationId: "notif-1", title: "Title", linkHref: null };

  it("resolves not-configured naming VAPID_PUBLIC_KEY when VAPID_* is unset, without calling webpush.sendNotification", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const sendNotificationSpy = vi.spyOn(webpush, "sendNotification");

    const result = await sendWebPushNotification(target, payload);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/VAPID_PUBLIC_KEY/) });
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });
});
