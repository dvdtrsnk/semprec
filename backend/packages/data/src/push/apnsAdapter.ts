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

/** The sources a notification can name that outlive the notification, so repeated pushes about one of them belong together (issue #1829). */
const DURABLE_SOURCE_TABLES: ReadonlySet<string> = new Set(["semp_problems", "approval_requests", "invites"]);

/** `apns-collapse-id` may not exceed 64 bytes. */
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/**
 * The key under which APNs collapses pushes about one thing and the device groups them (issue #1829): the
 * notification's source id when its source table has a durable identity (a Semp problem, an approval request
 * or an invitation), `null` for any other source and for an empty source id. A key longer than 64 bytes (the
 * limit of `apns-collapse-id`) is replaced by the first 64 hex characters of its SHA-256, which is the same for
 * the same source id every time.
 */
export function apnsCollapseKey(payload: Pick<NotificationPushPayload, "sourceTable" | "sourceId">): string | null {
  if (!DURABLE_SOURCE_TABLES.has(payload.sourceTable) || payload.sourceId === "") return null;
  if (Buffer.byteLength(payload.sourceId) <= APNS_COLLAPSE_ID_MAX_BYTES) return payload.sourceId;
  return crypto.createHash("sha256").update(payload.sourceId).digest("hex").slice(0, APNS_COLLAPSE_ID_MAX_BYTES);
}

/** A visible push that cannot be delivered within a day is not worth showing any more (issue #1829). */
const APNS_ALERT_TTL_SECONDS = 24 * 60 * 60;

/**
 * The `apns` half of issue #151's fanout adapters: HTTP/2 to production or sandbox depending on
 * this exact registration's `apns_environment`, an alert title (with `aps.alert.body` when the
 * notification has a body, issue #1773) plus `link_href` and `notification_id` in the payload (and
 * `aps["interruption-level"]` when the payload names one), and the shared, cached provider JWT above.
 * Every alert carries `apns-push-type: alert`, `apns-priority: 10` and an `apns-expiration` 24 hours after
 * the send; when the source has a durable identity (`apnsCollapseKey`) it also carries the same key as
 * `apns-collapse-id` and as `aps["thread-id"]` (issue #1829). `aps.category` and the top-level
 * `approvalRequestId` are sent only when the payload's `apns` fields carry them (issue #1831), and so are
 * the keys of `apns.data` (issue gh-1954), at the top level beside `aps`.
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
  const collapseKey = apnsCollapseKey(payload);
  const body = JSON.stringify({
    // The custom keys come first, so none of them can replace a key the adapter sets below.
    ...payload.apns?.data,
    // `alert.body` is sent only when the notification has one (issue #1773), so a notification of
    // another kind keeps the title-only alert it always had. `interruption-level` is sent only when
    // the fanout job decided one; without it APNs delivers at its default, `active`.
    aps: {
      alert: { title: payload.title, ...(payload.body === null ? {} : { body: payload.body }) },
      ...(payload.interruptionLevel === undefined ? {} : { "interruption-level": payload.interruptionLevel }),
      ...(collapseKey === null ? {} : { "thread-id": collapseKey }),
      ...(payload.apns?.category === undefined ? {} : { category: payload.apns.category }),
      ...(payload.badge === undefined ? {} : { badge: payload.badge }),
    },
    link_href: payload.linkHref,
    notification_id: payload.notificationId,
    ...(payload.apns?.approvalRequestId === undefined ? {} : { approvalRequestId: payload.apns.approvalRequestId }),
  });

  return sendApnsRequest(
    target,
    body,
    {
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + APNS_ALERT_TTL_SECONDS),
      ...(collapseKey === null ? {} : { "apns-collapse-id": collapseKey }),
    },
    config,
  );
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

/** The collapse id of every badge-only push: a newer one replaces an older one APNs still holds for the device. */
const APNS_BADGE_COLLAPSE_ID = "badge";

/**
 * A badge-only push (issue #1891): `aps` carries only `badge`, with no alert and no sound, so the app icon
 * changes without anything showing and the app is not woken. APNs requires the push type `alert` for a payload
 * that sets a badge, so the request carries `apns-push-type: alert`, `apns-priority: 5` (a low priority push
 * that does not wake the app) and `apns-collapse-id: badge`. A `badge` of `0` clears the badge. A `badge` that is
 * not a non-negative integer is rejected with a `ValidationError` before any request. The request, the provider
 * token and the result mapping are `sendApnsNotification`'s; the adapter only sends, and finding a user's
 * registrations and revoking a dead one stay with the caller.
 */
export async function sendApnsBadgeUpdate(
  target: ApnsTarget,
  badge: number,
  config?: ApnsConfig,
): Promise<PushSendResult> {
  if (!Number.isInteger(badge) || badge < 0) {
    throw new ValidationError("A badge must be a non-negative integer");
  }

  return sendApnsRequest(
    target,
    JSON.stringify({ aps: { badge } }),
    { "apns-push-type": "alert", "apns-priority": "5", "apns-collapse-id": APNS_BADGE_COLLAPSE_ID },
    config,
  );
}
