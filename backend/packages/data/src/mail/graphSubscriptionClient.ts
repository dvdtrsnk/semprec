import { assertJsonObject } from "./providerTypes.js";
import {
  GraphSubscriptionNotFoundError,
  type GraphSubscriptionRegistration,
  type GraphSubscriptionTransport,
} from "./graphWebhookLifecycle.js";

const SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";
/** Mailbox-wide, matching the reconcile's `/me/messages/delta` scope. */
const WATCHED_RESOURCE = "/me/messages";
/** Graph's maximum lifetime for `messages` subscriptions (~2.94 days). */
const MAX_EXPIRATION_MINUTES = 4230;

/** Bounds memory against an endpoint streaming an unbounded body. */
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;

class GraphApiError extends Error {
  constructor(public readonly status: number) {
    super(`Graph subscriptions API request failed with status ${status}`);
  }
}

async function readBoundedText(response: Response, url: string, maxBytes: number): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new Error(`Response from ${url} has no readable body stream`);
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

async function request(url: string, accessToken: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new GraphApiError(response.status);
  const text = await readBoundedText(response, url, MAX_JSON_RESPONSE_BYTES);
  return assertJsonObject(JSON.parse(text), `response from ${url}`);
}

function toRegistration(json: Record<string, unknown>): GraphSubscriptionRegistration {
  if (typeof json.id !== "string" || !json.id) {
    throw new Error("Graph subscriptions response is missing a string id");
  }
  if (typeof json.expirationDateTime !== "string" || !json.expirationDateTime) {
    throw new Error("Graph subscriptions response is missing a string expirationDateTime");
  }
  return { subscriptionId: json.id, expiresAt: new Date(json.expirationDateTime) };
}

function maxExpirationDateTime(): string {
  return new Date(Date.now() + MAX_EXPIRATION_MINUTES * 60 * 1000).toISOString();
}

/**
 * `GraphSubscriptionTransport` over `/subscriptions`. Renewal PATCHes only `expirationDateTime`
 * (`clientState` is immutable); creation POSTs with a fresh `clientState`.
 */
export function createGraphSubscriptionRestClient(
  getAccessToken: (mailboxItemId: string, credential: string) => Promise<string>,
): GraphSubscriptionTransport {
  return {
    async createSubscription(mailboxItemId, credential, params) {
      const accessToken = await getAccessToken(mailboxItemId, credential);
      const json = await request(SUBSCRIPTIONS_URL, accessToken, {
        method: "POST",
        body: JSON.stringify({
          changeType: "created,updated",
          notificationUrl: params.notificationUrl,
          resource: WATCHED_RESOURCE,
          expirationDateTime: maxExpirationDateTime(),
          clientState: params.clientState,
        }),
      });
      return toRegistration(json);
    },

    async renewSubscription(mailboxItemId, credential, subscriptionId) {
      const accessToken = await getAccessToken(mailboxItemId, credential);
      try {
        const json = await request(`${SUBSCRIPTIONS_URL}/${subscriptionId}`, accessToken, {
          method: "PATCH",
          body: JSON.stringify({ expirationDateTime: maxExpirationDateTime() }),
        });
        return toRegistration(json);
      } catch (err) {
        if (err instanceof GraphApiError && err.status === 404) {
          throw new GraphSubscriptionNotFoundError(`Graph subscription ${subscriptionId} no longer exists`);
        }
        throw err;
      }
    },
  };
}
