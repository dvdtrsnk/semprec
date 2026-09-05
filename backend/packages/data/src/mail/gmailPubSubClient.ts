import { assertJsonObject } from "./providerTypes.js";
import type { GmailPubSubNotification, GmailWatchRegistration, GmailWatchTransport } from "./gmailWatchLifecycle.js";

const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_BASE_URL = "https://pubsub.googleapis.com/v1";

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
}

async function jsonRequest<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Request to ${url} failed with status ${response.status}`);
  const body = assertJsonObject(await response.json(), `response from ${url}`);
  return body as T;
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
      const json = await jsonRequest<{ historyId: string; expiration: string }>(`${GMAIL_BASE_URL}/watch`, accessToken, {
        method: "POST",
        body: JSON.stringify({ topicName: options.topicName, ...(options.labelIds ? { labelIds: options.labelIds } : {}) }),
      });
      // Google returns `expiration` as a string of milliseconds-since-epoch, not an ISO date.
      return { historyId: json.historyId, expiresAt: new Date(Number(json.expiration)) };
    },

    async pull(_mailboxItemId): Promise<GmailPubSubNotification[]> {
      const accessToken = await options.getPubSubAccessToken();
      const json = await jsonRequest<{
        receivedMessages?: Array<{ ackId: string; message: { data: string } }>;
      }>(`${PUBSUB_BASE_URL}/${options.subscriptionName}:pull`, accessToken, {
        method: "POST",
        body: JSON.stringify({ maxMessages }),
      });

      return (json.receivedMessages ?? []).map((received) => {
        // Gmail's watch payload is base64 `{"emailAddress": "...", "historyId": "..."}`, itself
        // wrapped as Pub/Sub's own base64 `message.data` — an extra layer of encoding on top of
        // the `format=full` base64url bodies gmailRestClient.ts decodes, not the same alphabet
        // (Pub/Sub's `message.data` is standard base64, unlike Gmail message parts' base64url).
        const decoded = assertJsonObject(
          JSON.parse(Buffer.from(received.message.data, "base64").toString("utf8")),
          `Pub/Sub notification payload for ackId ${received.ackId}`,
        );
        if (typeof decoded.emailAddress !== "string" || typeof decoded.historyId !== "string") {
          throw new Error(`Pub/Sub notification payload for ackId ${received.ackId} is missing emailAddress/historyId`);
        }
        return { ackId: received.ackId, emailAddress: decoded.emailAddress, historyId: decoded.historyId };
      });
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
