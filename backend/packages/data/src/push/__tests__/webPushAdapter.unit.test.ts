import webpush from "web-push";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebPushNotification } from "../webPushAdapter.js";
import type { NotificationPushPayload } from "../pushSenders.js";

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
  const payload = { notificationId: "notif-1", title: "Title", body: null, linkHref: null };

  it("resolves not-configured naming VAPID_PUBLIC_KEY when VAPID_* is unset, without calling webpush.sendNotification", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const sendNotificationSpy = vi.spyOn(webpush, "sendNotification");

    const result = await sendWebPushNotification(target, payload);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/VAPID_PUBLIC_KEY/) });
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });
});

describe("sendWebPushNotification body (issue #1773)", () => {
  const target = { endpoint: "https://push.example/web-2", p256dh: "p256dh-key", authSecret: "auth-secret" };
  const config = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:ops@example.test" };

  /** Sends through a stubbed `webpush.sendNotification` and returns the JSON payload the adapter handed to it. */
  async function sendAndReadPayload(payload: NotificationPushPayload): Promise<unknown> {
    const sendNotificationSpy = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    const result = await sendWebPushNotification(target, payload, config);

    expect(result).toEqual({ outcome: "delivered" });
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const sentPayload: unknown = sendNotificationSpy.mock.calls[0]?.[1];
    if (typeof sentPayload !== "string") throw new Error("expected the adapter to send a string payload");
    return JSON.parse(sentPayload);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends body beside title when the notification has a body", async () => {
    const sent = await sendAndReadPayload({
      notificationId: "notif-5",
      title: "Semp needs approval",
      body: 'Call the tool "search_web" on the MCP server "Search". This action is irreversible.',
      linkHref: "?page=approvals&user=u1",
    });

    expect(sent).toEqual({
      title: "Semp needs approval",
      body: 'Call the tool "search_web" on the MCP server "Search". This action is irreversible.',
      linkHref: "?page=approvals&user=u1",
      notificationId: "notif-5",
    });
  });

  it("omits the body key, not a null body, when the notification has none", async () => {
    const sent = await sendAndReadPayload({ notificationId: "notif-6", title: "Title", body: null, linkHref: null });

    expect(sent).toEqual({ title: "Title", linkHref: null, notificationId: "notif-6" });
    expect(sent).not.toHaveProperty("body");
  });

  it("omits APNs interruption level from the delivered Web Push payload", async () => {
    const sent = await sendAndReadPayload({
      notificationId: "notif-7",
      title: "Title",
      body: "Body",
      linkHref: "?page=approvals",
      interruptionLevel: "time-sensitive",
    });

    expect(sent).toEqual({
      title: "Title",
      body: "Body",
      linkHref: "?page=approvals",
      notificationId: "notif-7",
    });
    expect(sent).not.toHaveProperty("interruptionLevel");
  });
});
