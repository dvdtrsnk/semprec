import webpush from "web-push";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebPushDismiss, sendWebPushNotification } from "../webPushAdapter.js";
import type { NotificationPushPayload } from "../pushSenders.js";

/** The source fields of a notification whose source has no durable identity (issue #1829), so no collapse key. */
const NO_IDENTITY_SOURCE = {
  sourceTable: "project_heartbeats",
  sourceId: "heartbeat-1",
  kind: "heartbeat_error",
} as const;

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
  const payload = { notificationId: "notif-1", ...NO_IDENTITY_SOURCE, title: "Title", body: null, linkHref: null };

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
      ...NO_IDENTITY_SOURCE,
      title: "Semp needs approval",
      body: 'Call the tool "search_web" on the MCP server "Search". This action is irreversible.',
      linkHref: "?page=approvals&user=u1",
    });

    expect(sent).toEqual({
      title: "Semp needs approval",
      body: 'Call the tool "search_web" on the MCP server "Search". This action is irreversible.',
      linkHref: "?page=approvals&user=u1",
      notificationId: "notif-5",
      tag: "notif-5",
    });
  });

  it("omits the body key, not a null body, when the notification has none", async () => {
    const sent = await sendAndReadPayload({
      notificationId: "notif-6",
      ...NO_IDENTITY_SOURCE,
      title: "Title",
      body: null,
      linkHref: null,
    });

    expect(sent).toEqual({ title: "Title", linkHref: null, notificationId: "notif-6", tag: "notif-6" });
    expect(sent).not.toHaveProperty("body");
  });

  it("omits APNs interruption level from the delivered Web Push payload", async () => {
    const sent = await sendAndReadPayload({
      notificationId: "notif-7",
      ...NO_IDENTITY_SOURCE,
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
      tag: "notif-7",
    });
    expect(sent).not.toHaveProperty("interruptionLevel");
  });

  it("leaves the APNs category and the request id of an approval out of the delivered Web Push payload (issue #1831)", async () => {
    const sent = await sendAndReadPayload({
      notificationId: "notif-9",
      title: "Semp needs approval",
      body: "Body",
      linkHref: "?page=approvals",
      interruptionLevel: "time-sensitive",
      sourceTable: "approval_requests",
      sourceId: "5d2f0d6e-2f4b-4a0c-9a43-0d1d3a8d7a10",
      kind: "approval_pending",
      apns: { category: "APPROVAL_REQUEST", approvalRequestId: "5d2f0d6e-2f4b-4a0c-9a43-0d1d3a8d7a10" },
    });

    expect(sent).toEqual({
      title: "Semp needs approval",
      body: "Body",
      linkHref: "?page=approvals",
      notificationId: "notif-9",
      tag: "notif-9",
    });
  });

  it("leaves the APNs category and the invitation id of a calendar invitation out of the delivered Web Push payload (issue gh-1954)", async () => {
    const sent = await sendAndReadPayload({
      notificationId: "notif-10",
      title: "Olga invites you: Sprint review",
      body: null,
      linkHref: null,
      interruptionLevel: "active",
      sourceTable: "items",
      sourceId: "0c0e3bb4-2d4c-4f43-8c7b-6b5f4f1d3f10",
      kind: "calendar_invitation",
      apns: { category: "CALENDAR_INVITATION", data: { invitation_id: "0c0e3bb4-2d4c-4f43-8c7b-6b5f4f1d3f10" } },
    });

    expect(sent).toEqual({
      title: "Olga invites you: Sprint review",
      linkHref: null,
      notificationId: "notif-10",
      tag: "notif-10",
    });
  });
});

describe("sendWebPushNotification tag (issue #1826)", () => {
  const target = { endpoint: "https://push.example/web-3", p256dh: "p256dh-key", authSecret: "auth-secret" };
  const config = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:ops@example.test" };

  it("tags the visible message with the notification id, so a later dismiss can name the same id", async () => {
    const sendNotificationSpy = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    await sendWebPushNotification(
      target,
      { notificationId: "notif-8", ...NO_IDENTITY_SOURCE, title: "Title", body: null, linkHref: null },
      config,
    );

    const sent: unknown = sendNotificationSpy.mock.calls[0]?.[1];
    if (typeof sent !== "string") throw new Error("expected the adapter to send a string payload");
    expect(JSON.parse(sent)).toMatchObject({ notificationId: "notif-8", tag: "notif-8" });
  });
});

describe("sendWebPushDismiss (issue #1826)", () => {
  const target = { endpoint: "https://push.example/web-4", p256dh: "p256dh-key", authSecret: "auth-secret" };
  const config = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:ops@example.test" };

  it("sends exactly the message { dismiss: [ids] }", async () => {
    const sendNotificationSpy = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    const result = await sendWebPushDismiss(target, ["notif-9", "notif-10"], config);

    expect(result).toEqual({ outcome: "delivered" });
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    expect(sendNotificationSpy.mock.calls[0]?.[1]).toBe('{"dismiss":["notif-9","notif-10"]}');
  });

  it("maps a 410 answer to permanent-failure and any other failure to transient-failure", async () => {
    const gone = new webpush.WebPushError("gone", 410, {}, "", target.endpoint);
    vi.spyOn(webpush, "sendNotification").mockRejectedValueOnce(gone);
    expect(await sendWebPushDismiss(target, ["notif-11"], config)).toEqual({
      outcome: "permanent-failure",
      error: gone,
    });

    const unavailable = new webpush.WebPushError("unavailable", 503, {}, "", target.endpoint);
    vi.spyOn(webpush, "sendNotification").mockRejectedValueOnce(unavailable);
    expect(await sendWebPushDismiss(target, ["notif-11"], config)).toEqual({
      outcome: "transient-failure",
      error: unavailable,
    });
  });

  it("resolves not-configured when VAPID_* is unset, without calling webpush.sendNotification", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const sendNotificationSpy = vi.spyOn(webpush, "sendNotification");

    const result = await sendWebPushDismiss(target, ["notif-12"]);

    expect(result).toEqual({ outcome: "not-configured", reason: expect.stringMatching(/VAPID_PUBLIC_KEY/) });
    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });
});
