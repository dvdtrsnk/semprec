import http2 from "node:http2";
import crypto from "node:crypto";
import type { ApnsEnvironment } from "./types.js";
import type { ApnsTarget, NotificationPushPayload, PushSendResult } from "./pushSenders.js";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** PEM-encoded PKCS#8 EC private key (the `.p8` APNs auth key), as issued by Apple. */
  privateKey: string;
  /** The app's bundle id, sent as `apns-topic`. */
  topic: string;
}

/** Never provisioned here (operations' job, per issue #151's scope) — read lazily, only when a send is actually attempted. */
function getApnsConfigFromEnv(): ApnsConfig {
  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;
  const topic = process.env.APNS_TOPIC;
  if (!teamId || !keyId || !privateKey || !topic) {
    throw new Error("APNs delivery requires APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, and APNS_TOPIC to be set");
  }
  return { teamId, keyId, privateKey, topic };
}

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** APNs provider tokens are valid up to one hour; the issue's Task caps reuse at that maximum, so this regenerates a little early rather than risk a request landing right at the boundary. */
const MAX_PROVIDER_TOKEN_AGE_MS = 55 * 60 * 1000;

interface CachedProviderToken {
  token: string;
  keyId: string;
  issuedAtMs: number;
}

let cachedProviderToken: CachedProviderToken | undefined;

function base64url(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString("base64url");
}

/** One ES256 JWT reused across sends (issue #151's Task: "caches an ES256 provider JWT for no longer than one hour"). */
function getProviderJwt(config: ApnsConfig): string {
  const now = Date.now();
  if (
    cachedProviderToken &&
    cachedProviderToken.keyId === config.keyId &&
    now - cachedProviderToken.issuedAtMs < MAX_PROVIDER_TOKEN_AGE_MS
  ) {
    return cachedProviderToken.token;
  }

  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signature = base64url(
    crypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: config.privateKey,
      dsaEncoding: "ieee-p1363",
    }),
  );
  const token = `${header}.${claims}.${signature}`;
  cachedProviderToken = { token, keyId: config.keyId, issuedAtMs: now };
  return token;
}

interface ApnsResponse {
  status: number;
  reason?: string;
}

/** A hung APNs connection/request must not block a graphile-worker task runner slot forever. */
const APNS_REQUEST_TIMEOUT_MS = 10_000;

function postApnsRequest(
  host: string,
  deviceToken: string,
  headers: http2.OutgoingHttpHeaders,
  body: string,
): Promise<ApnsResponse> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    let settled = false;

    const timeout = setTimeout(() => {
      fail(new Error(`APNs request to ${host} timed out after ${APNS_REQUEST_TIMEOUT_MS}ms`));
    }, APNS_REQUEST_TIMEOUT_MS);
    timeout.unref?.();

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      reject(error);
    }

    function succeed(response: ApnsResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.close();
      resolve(response);
    }

    client.on("error", fail);

    const req = client.request({
      ...headers,
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
    });

    let status = 0;
    let responseBody = "";
    req.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"]);
    });
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      responseBody += chunk;
    });
    req.on("end", () => {
      let reason: string | undefined;
      try {
        reason = responseBody ? (JSON.parse(responseBody) as { reason?: string }).reason : undefined;
      } catch {
        reason = undefined;
      }
      succeed({ status, reason });
    });
    req.on("error", fail);
    req.end(body);
  });
}

/**
 * The `apns` half of issue #151's fanout adapters: HTTP/2 to production or sandbox depending on
 * this exact registration's `apns_environment`, alert title/body plus `link_href` and
 * `notification_id` in the payload, and the shared, cached provider JWT above. A 410 or
 * `BadDeviceToken` means this exact device token is dead — the caller pairs that with #150's
 * `revokePushSubscriptionByProviderInvalidation`. Everything else (network failure, other 4xx/5xx)
 * is transient and left for the job's own retry.
 */
export async function sendApnsNotification(
  target: ApnsTarget,
  payload: NotificationPushPayload,
  config: ApnsConfig = getApnsConfigFromEnv(),
): Promise<PushSendResult> {
  const body = JSON.stringify({
    // `notifications` (migration 0030) has no separate body/description column — `title` is the
    // only user-facing text there is, so the alert carries it as `title` alone rather than
    // duplicating it into `body` too.
    aps: { alert: { title: payload.title } },
    link_href: payload.linkHref,
    notification_id: payload.notificationId,
  });

  try {
    const response = await postApnsRequest(
      APNS_HOSTS[target.apnsEnvironment],
      target.deviceToken,
      {
        authorization: `bearer ${getProviderJwt(config)}`,
        "apns-topic": config.topic,
        "content-type": "application/json",
      },
      body,
    );

    if (response.status === 200) return { outcome: "delivered" };
    if (response.status === 410 || response.reason === "BadDeviceToken") {
      return { outcome: "permanent-failure", error: response.reason ?? `status ${response.status}` };
    }
    return { outcome: "transient-failure", error: response.reason ?? `status ${response.status}` };
  } catch (error) {
    return { outcome: "transient-failure", error };
  }
}
