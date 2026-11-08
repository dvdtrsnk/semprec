import fs from "node:fs";
import http2 from "node:http2";
import crypto from "node:crypto";
import { ValidationError } from "../errors.js";
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

/** Keyed by path so a changed `APNS_PRIVATE_KEY_PATH` (e.g. across tests) never serves a stale key. */
const privateKeyCache = new Map<string, string>();

function readPrivateKey(privateKeyPath: string): string {
  const cached = privateKeyCache.get(privateKeyPath);
  if (cached !== undefined) return cached;
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");
  privateKeyCache.set(privateKeyPath, privateKey);
  return privateKey;
}

/**
 * Provisioned by issue #175: `APNS_PRIVATE_KEY_PATH` points at the `apns-key.p8` file
 * distributed alongside `/opt/semprec/shared/.env`, provisioned readable by the service user by
 * `deploy/provision.sh`, never at inline PEM — a multi-line key has no safe representation in a
 * systemd `EnvironmentFile=`/Docker `env_file:` line, and shipping it as its own file keeps it
 * out of `.env` and out of any process log that might dump environment variables. Read lazily,
 * only when a send is actually attempted, and cached thereafter — this is called on every
 * `sendApnsNotification`, and the file never changes without a process restart.
 */
export function getApnsConfigFromEnv(): ApnsConfig {
  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKeyPath = process.env.APNS_PRIVATE_KEY_PATH;
  const topic = process.env.APNS_TOPIC;
  if (!teamId || !keyId || !privateKeyPath || !topic) {
    throw new Error(
      "APNs delivery requires APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY_PATH, and APNS_TOPIC to be set",
    );
  }
  return { teamId, keyId, privateKey: readPrivateKey(privateKeyPath), topic };
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

/** APNs error bodies are a small JSON object (`{"reason": "..."}`); anything past this is not a legitimate response. */
const MAX_APNS_RESPONSE_BYTES = 64 * 1024;

function extractReason(responseBody: string): string | undefined {
  if (!responseBody) return undefined;
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).reason === "string"
    ) {
      return (parsed as Record<string, unknown>).reason as string;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

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
      if (responseBody.length + chunk.length > MAX_APNS_RESPONSE_BYTES) {
        fail(new Error(`APNs response from ${host} exceeded ${MAX_APNS_RESPONSE_BYTES} bytes`));
        return;
      }
      responseBody += chunk;
    });
    req.on("end", () => {
      succeed({ status, reason: extractReason(responseBody) });
    });
    req.on("error", fail);
    req.end(body);
  });
}

/**
 * The `apns` half of issue #151's fanout adapters: HTTP/2 to production or sandbox depending on
 * this exact registration's `apns_environment`, an alert title (with `aps.alert.body` when the
 * notification has a body, issue #1773) plus `link_href` and `notification_id` in the payload (and
 * `aps["interruption-level"]` when the payload names one), and the shared, cached provider JWT above.
 * A 410 or `BadDeviceToken` means this exact device token is dead — the caller pairs that with #150's
 * `revokePushSubscriptionByProviderInvalidation`. Everything else (network failure, other 4xx/5xx)
 * is transient and left for the job's own retry. Missing `APNS_*` env vars or an unreadable key
 * file (issue #703) resolve `not-configured` instead of throwing — a server-side gap, not a
 * verdict on this device token.
 */
export async function sendApnsNotification(
  target: ApnsTarget,
  payload: NotificationPushPayload,
  config?: ApnsConfig,
): Promise<PushSendResult> {
  const body = JSON.stringify({
    // `alert.body` is sent only when the notification has one (issue #1773), so a notification of
    // another kind keeps the title-only alert it always had. `interruption-level` is sent only when
    // the fanout job decided one; without it APNs delivers at its default, `active`.
    aps: {
      alert: { title: payload.title, ...(payload.body === null ? {} : { body: payload.body }) },
      ...(payload.interruptionLevel === undefined ? {} : { "interruption-level": payload.interruptionLevel }),
    },
    link_href: payload.linkHref,
    notification_id: payload.notificationId,
  });

  return sendApnsRequest(target, body, {}, config);
}

/**
 * Sends one encoded request and maps APNs' answer to a `PushSendResult`. The alert and background
 * pushes both go through it, so the provider JWT, the 410/`BadDeviceToken` rule and the transient
 * fallback exist once. `extraHeaders` holds only what differs between the two push types.
 */
async function sendApnsRequest(
  target: ApnsTarget,
  body: string,
  extraHeaders: http2.OutgoingHttpHeaders,
  config: ApnsConfig | undefined,
): Promise<PushSendResult> {
  let resolvedConfig: ApnsConfig;
  try {
    resolvedConfig = config ?? getApnsConfigFromEnv();
  } catch (error) {
    return { outcome: "not-configured", reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    const response = await postApnsRequest(
      APNS_HOSTS[target.apnsEnvironment],
      target.deviceToken,
      {
        authorization: `bearer ${getProviderJwt(resolvedConfig)}`,
        "apns-topic": resolvedConfig.topic,
        "content-type": "application/json",
        ...extraHeaders,
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

/**
 * A silent background push (issue #1445): `aps` carries only `content-available: 1`, with no alert,
 * sound or badge, so APNs can wake the app to reload its data without showing anything. The
 * caller's `data` is sent beside `aps`, unchanged. A `data` that names `aps` would replace the
 * wake-up key, so it is rejected with a `ValidationError` before any request. The request, the
 * provider token and the result mapping are `sendApnsNotification`'s. The adapter only sends:
 * finding a user's registrations and revoking a dead one stay with the caller, and nothing is
 * written to `notifications` or `push_deliveries`.
 */
export async function sendApnsBackgroundPush(
  target: ApnsTarget,
  data: Record<string, unknown>,
  config?: ApnsConfig,
): Promise<PushSendResult> {
  if (Object.hasOwn(data, "aps")) {
    throw new ValidationError("A background push payload must not contain the aps key");
  }

  const body = JSON.stringify({ aps: { "content-available": 1 }, ...data });
  return sendApnsRequest(target, body, { "apns-push-type": "background", "apns-priority": "5" }, config);
}
