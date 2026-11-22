import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailPubSubTransport } from "../mail/gmailPubSubClient.js";

const SUBSCRIPTION = "projects/semprec-test/subscriptions/gmail-push-pull";

function received(ackId: string, payload: unknown) {
  return { ackId, message: { data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") } };
}

function transportPulling(receivedMessages: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ receivedMessages }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  const malformed: unknown[] = [];
  const transport = createGmailPubSubTransport({
    getGmailAccessToken: async () => "gmail-token",
    getPubSubAccessToken: async () => "pubsub-token",
    topicName: "projects/semprec-test/topics/gmail-push",
    subscriptionName: SUBSCRIPTION,
    onMalformedNotification: (raw) => malformed.push(raw),
  });
  return { transport, fetchImpl, malformed };
}

describe("Gmail Pub/Sub pull", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["a JSON number, as Gmail publishes it", 7758, "7758"],
    ["a decimal string, as Gmail documents it", "9876543210", "9876543210"],
  ])("reads a historyId sent as %s", async (_name, historyId, expected) => {
    const { transport, fetchImpl, malformed } = transportPulling([
      received("ack-1", { emailAddress: "someone@gmail.com", historyId }),
    ]);

    await expect(transport.pull()).resolves.toEqual([
      { ackId: "ack-1", emailAddress: "someone@gmail.com", historyId: expected },
    ]);
    expect(malformed).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:pull`);
  });

  it.each([
    ["missing", { emailAddress: "someone@gmail.com" }],
    ["negative", { emailAddress: "someone@gmail.com", historyId: -1 }],
    ["fractional", { emailAddress: "someone@gmail.com", historyId: 1.5 }],
    ["beyond a safe integer", { emailAddress: "someone@gmail.com", historyId: Number.MAX_SAFE_INTEGER + 2 }],
    ["not decimal text", { emailAddress: "someone@gmail.com", historyId: "12a" }],
    ["paired with no address", { historyId: 7758 }],
  ])("reports a notification whose historyId is %s and keeps the rest of the batch", async (_name, payload) => {
    const bad = received("ack-bad", payload);
    const { transport, malformed } = transportPulling([
      bad,
      received("ack-good", { emailAddress: "other@gmail.com", historyId: 12 }),
    ]);

    await expect(transport.pull()).resolves.toEqual([
      { ackId: "ack-good", emailAddress: "other@gmail.com", historyId: "12" },
    ]);
    expect(malformed).toEqual([bad]);
  });
});
