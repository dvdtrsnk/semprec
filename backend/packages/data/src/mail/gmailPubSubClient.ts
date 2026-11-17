import { assertJsonObject } from "./providerTypes.js";
import type { GmailPubSubNotification, GmailWatchRegistration, GmailWatchTransport } from "./gmailWatchLifecycle.js";

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_BASE_URL = "https://pubsub.googleapis.com/v1";

/** Bounds memory against a misbehaving endpoint; far above any legitimate response. */
const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface GmailPubSubClientOptions {
  /** Exchanges the account's refresh token for a bearer token; only `users.watch` runs under the account's grant. */
  getGmailAccessToken: (mailboxItemId: string, credential: string) => Promise<string>;
  /**
   * Pub/Sub calls authenticate as the app's own GCP service account: a Gmail grant has no Pub/Sub
   * scope, and the subscription is shared by every watched account.
   */
  getPubSubAccessToken: () => Promise<string>;
  /** `projects/{project}/topics/{topic}`, provisioned outside this code. */
  topicName: string;
  /** `projects/{project}/subscriptions/{subscription}`, provisioned outside this code. */
  subscriptionName: string;
  /** Gmail default: all changes. */
  labelIds?: string[];
  /** Google caps this at 1000. */
  maxPullMessages?: number;
  /**
   * Observability only. A malformed entry is skipped so it cannot block the rest of the batch,
   * and left unacknowledged so Pub/Sub redelivers it.
   */
  onMalformedNotification?: (raw: unknown, err: unknown) => void;
}

async function readBoundedText(response: Response, url: string, maxBytes: number): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response from ${url} exceeded the ${maxBytes}-byte cap`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** Deliberately untyped: each call site validates the fields it reads. */
async function jsonRequest(url: string, accessToken: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Request to ${url} failed with status ${response.status}`);
  const text = await readBoundedText(response, url, MAX_JSON_RESPONSE_BYTES);
  return assertJsonObject(JSON.parse(text), `response from ${url}`);
}

function parseReceivedMessage(raw: unknown): GmailPubSubNotification {
  const received = assertJsonObject(raw, "Pub/Sub receivedMessages entry");
  if (typeof received.ackId !== "string" || !received.ackId) {
    throw new Error("Pub/Sub receivedMessages entry is missing a string ackId");
  }
  const message = assertJsonObject(received.message, `Pub/Sub message for ackId ${received.ackId}`);
  if (typeof message.data !== "string") {
    throw new Error(`Pub/Sub message for ackId ${received.ackId} is missing string data`);
  }
  // `message.data` is standard base64 (not the base64url of Gmail message parts) of
  // `{"emailAddress", "historyId"}`.
  const decoded = assertJsonObject(
    JSON.parse(Buffer.from(message.data, "base64").toString("utf8")),
    `Pub/Sub notification payload for ackId ${received.ackId}`,
  );
  if (typeof decoded.emailAddress !== "string" || typeof decoded.historyId !== "string") {
    throw new Error(`Pub/Sub notification payload for ackId ${received.ackId} is missing emailAddress/historyId`);
  }
  return { ackId: received.ackId, emailAddress: decoded.emailAddress, historyId: decoded.historyId };
}

/**
 * Gmail `users.watch` plus Pub/Sub `pull`/`acknowledge` over plain `fetch` (no vendor SDK). Not
 * covered by tests; the lifecycle is tested against a fake transport.
 */
export function createGmailPubSubTransport(options: GmailPubSubClientOptions): GmailWatchTransport {
  const maxMessages = options.maxPullMessages ?? 100;

  return {
    async registerWatch(mailboxItemId, credential): Promise<GmailWatchRegistration> {
      const accessToken = await options.getGmailAccessToken(mailboxItemId, credential);
      const json = await jsonRequest(`${GMAIL_BASE_URL}/watch`, accessToken, {
        method: "POST",
        body: JSON.stringify({
          topicName: options.topicName,
          ...(options.labelIds ? { labelIds: options.labelIds } : {}),
        }),
      });
      if (typeof json.historyId !== "string" || !json.historyId) {
        throw new Error("users.watch response is missing a string historyId");
      }
      // Google returns `expiration` as a string of milliseconds-since-epoch, not an ISO date.
      if (typeof json.expiration !== "string" || !json.expiration) {
        throw new Error("users.watch response is missing a string expiration");
      }
      return { historyId: json.historyId, expiresAt: new Date(Number(json.expiration)) };
    },

    async pull(): Promise<GmailPubSubNotification[]> {
      const accessToken = await options.getPubSubAccessToken();
      const json = await jsonRequest(`${PUBSUB_BASE_URL}/${options.subscriptionName}:pull`, accessToken, {
        method: "POST",
        body: JSON.stringify({ maxMessages }),
      });
      if (json.receivedMessages === undefined) return [];
      if (!Array.isArray(json.receivedMessages)) {
        throw new Error("Pub/Sub pull response's receivedMessages is not an array");
      }

      const notifications: GmailPubSubNotification[] = [];
      for (const raw of json.receivedMessages) {
        try {
          notifications.push(parseReceivedMessage(raw));
        } catch (err) {
          options.onMalformedNotification?.(raw, err);
        }
      }
      return notifications;
    },

    async acknowledge(ackIds): Promise<void> {
      if (ackIds.length === 0) return;
      const accessToken = await options.getPubSubAccessToken();
      await jsonRequest(`${PUBSUB_BASE_URL}/${options.subscriptionName}:acknowledge`, accessToken, {
        method: "POST",
        body: JSON.stringify({ ackIds }),
      });
    },
  };
}
