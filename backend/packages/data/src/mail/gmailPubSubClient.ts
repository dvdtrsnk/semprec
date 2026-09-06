import { assertJsonObject } from "./providerTypes.js";
import type { GmailPubSubNotification, GmailWatchRegistration, GmailWatchTransport } from "./gmailWatchLifecycle.js";

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_BASE_URL = "https://pubsub.googleapis.com/v1";

/**
 * Hard cap on a single response body — generous for anything Gmail/Pub/Sub's JSON APIs
 * legitimately return (a `users.watch` ack, a page of at most `maxPullMessages` notifications),
 * but bounds a misbehaving or compromised endpoint's ability to exhaust process memory by
 * streaming an unbounded body before `response.json()` would otherwise buffer all of it.
 */
const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface GmailPubSubClientOptions {
  /**
   * Exchanges one account's decrypted OAuth refresh token (`credential`, as decrypted by
   * `getDecryptedCredential`) for a Gmail-API bearer token — called fresh per `registerWatch`,
   * same `oauthTokenExchange.ts`-backed shape `mailSyncJob.ts` already uses when it builds a
   * per-account `GmailRestClient`. Only `users.watch` needs this: it is the one call made under
   * the watched account's own OAuth grant.
   */
  getGmailAccessToken: (mailboxItemId: string, credential: string) => Promise<string>;
  /**
   * The Cloud Pub/Sub `pull`/`acknowledge` calls authenticate as this app's own GCP service
   * account, not as any watched Gmail account — a user's Gmail OAuth grant has no Pub/Sub scope
   * at all, and the topic/subscription is shared across every watched account in this project
   * (`subscriptionName` below), not owned by one of them. Called fresh per request; this
   * transport instance is shared across every Gmail-mode account's lifecycle (mirroring
   * `ImapIdleTransport`'s design, where one transport instance serves every account).
   */
  getPubSubAccessToken: () => Promise<string>;
  /** `projects/{project}/topics/{topic}` — the already-provisioned Pub/Sub topic `users.watch` publishes to (GCP topic/subscription creation is explicitly out of scope for this issue). */
  topicName: string;
  /** `projects/{project}/subscriptions/{subscription}` — the already-provisioned pull subscription on that topic, shared by every watched account in this GCP project. */
  subscriptionName: string;
  /** Restricts notifications to these labels (Gmail default: all changes). Matches `users.watch`'s own `labelIds` request field. */
  labelIds?: string[];
  /** How many messages to request per pull — Google caps this at 1000; small accounts never need that many at once. */
  maxPullMessages?: number;
  /**
   * Called for a `receivedMessages` entry that doesn't parse as a valid notification (a version
   * skew this parser doesn't understand yet, a malformed payload) — observability only. The
   * entry itself is skipped, not thrown out of the whole batch: one bad notification must never
   * block every other, well-formed notification in the same pull response from being processed.
   * Left unacknowledged, so Pub/Sub redelivers it rather than losing it.
   */
  onMalformedNotification?: (raw: unknown, err: unknown) => void;
}

/** Reads a response body up to `maxBytes`, throwing rather than buffering an unbounded stream — `response.json()` alone has no such limit. */
async function readBoundedText(response: Response, url: string, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
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

/**
 * Returns the parsed JSON object, never cast to a caller-chosen type — every call site
 * validates the specific fields it needs (an `as T` cast here would let a response missing an
 * expected field flow silently into `Number(undefined)`/`undefined.property` deep inside a
 * caller instead of failing at the request boundary with a clear error).
 */
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

/**
 * Parses one Cloud Pub/Sub `receivedMessages` entry into a `GmailPubSubNotification`, validating
 * every field it reads along the way — throws on the first thing that doesn't match rather than
 * letting a missing/mistyped field reach the caller as `undefined`.
 */
function parseReceivedMessage(raw: unknown): GmailPubSubNotification {
  const received = assertJsonObject(raw, "Pub/Sub receivedMessages entry");
  if (typeof received.ackId !== "string" || !received.ackId) {
    throw new Error("Pub/Sub receivedMessages entry is missing a string ackId");
  }
  const message = assertJsonObject(received.message, `Pub/Sub message for ackId ${received.ackId}`);
  if (typeof message.data !== "string") {
    throw new Error(`Pub/Sub message for ackId ${received.ackId} is missing string data`);
  }
  // Gmail's watch payload is base64 `{"emailAddress": "...", "historyId": "..."}`, itself
  // wrapped as Pub/Sub's own base64 `message.data` — an extra layer of encoding on top of the
  // `format=full` base64url bodies gmailRestClient.ts decodes, not the same alphabet (Pub/Sub's
  // `message.data` is standard base64, unlike Gmail message parts' base64url).
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
 * Real `GmailWatchTransport` (gmailWatchLifecycle.ts) over the Gmail REST `users.watch`
 * endpoint plus the Cloud Pub/Sub REST `pull`/`acknowledge` endpoints — plain `fetch`, not the
 * `@google-cloud/pubsub` SDK, matching `GmailRestClient`'s (gmailRestClient.ts) own choice to
 * keep this package free of a network-vendor dependency beyond parsing libraries. Not exercised
 * by this issue's tests (no live Google account or GCP project in CI) — the orchestration this
 * depends on (renewal cadence, notification-to-reconcile handoff, account-validation filtering)
 * is what is actually unit-tested, against a fake transport in gmailWatchLifecycle.test.ts.
 */
export function createGmailPubSubTransport(options: GmailPubSubClientOptions): GmailWatchTransport {
  const maxMessages = options.maxPullMessages ?? 100;

  return {
    async registerWatch(mailboxItemId, credential): Promise<GmailWatchRegistration> {
      const accessToken = await options.getGmailAccessToken(mailboxItemId, credential);
      const json = await jsonRequest(`${GMAIL_BASE_URL}/watch`, accessToken, {
        method: "POST",
        body: JSON.stringify({ topicName: options.topicName, ...(options.labelIds ? { labelIds: options.labelIds } : {}) }),
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

    async pull(_mailboxItemId): Promise<GmailPubSubNotification[]> {
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

    async acknowledge(_mailboxItemId, ackIds): Promise<void> {
      if (ackIds.length === 0) return;
      const accessToken = await options.getPubSubAccessToken();
      await jsonRequest(`${PUBSUB_BASE_URL}/${options.subscriptionName}:acknowledge`, accessToken, {
        method: "POST",
        body: JSON.stringify({ ackIds }),
      });
    },
  };
}
