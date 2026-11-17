import fs from "node:fs";
import http2 from "node:http2";
import crypto from "node:crypto";
import { ValidationError } from "../errors.js";
import type { ApnsEnvironment } from "./types.js";
import type { ApnsTarget, NotificationPushPayload, PushSendResult } from "./pushSenders.js";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** PEM PKCS#8 EC key (the `.p8` APNs auth key). */
  privateKey: string;
  /** Sent as `apns-topic`. */
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
 * A key file path, never inline PEM: a multi-line key cannot live safely in an env file, and a
 * separate file keeps it out of env dumps in logs. Read lazily on first send, then cached.
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

/** Tokens are valid up to one hour; regenerate a little early rather than hit the boundary. */
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

/** Error bodies are a small `{"reason"}` object; anything larger is not legitimate. */
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

/** Sources that outlive the notification, so repeated pushes about one belong together. */
const DURABLE_SOURCE_TABLES: ReadonlySet<string> = new Set(["semp_problems", "approval_requests", "invites"]);

/** `apns-collapse-id` may not exceed 64 bytes. */
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/** `null` without a durable source. A key over 64 bytes is replaced by a stable SHA-256 hex prefix. */
export function apnsCollapseKey(payload: Pick<NotificationPushPayload, "sourceTable" | "sourceId">): string | null {
  if (!DURABLE_SOURCE_TABLES.has(payload.sourceTable) || payload.sourceId === "") return null;
  if (Buffer.byteLength(payload.sourceId) <= APNS_COLLAPSE_ID_MAX_BYTES) return payload.sourceId;
  return crypto.createHash("sha256").update(payload.sourceId).digest("hex").slice(0, APNS_COLLAPSE_ID_MAX_BYTES);
}

/** A visible push undeliverable within a day is no longer worth showing. */
const APNS_ALERT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Environment follows the registration's `apns_environment`. A durable source's collapse key is
 * sent as both `apns-collapse-id` and `thread-id`.
 *
 * 410 or `BadDeviceToken` is permanent (the caller revokes the registration); everything else is
 * transient. Missing config or an unreadable key resolves `not-configured`, a server-side gap
 * rather than a verdict on the device.
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
    // Without `interruption-level` APNs delivers at its default, `active`.
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

/** Shared by every push type so the JWT and the result mapping exist once. */
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
 * Silent push (`content-available: 1` only) that wakes the app to reload. `data` naming `aps`
 * would replace the wake-up key and is rejected. Sends only; writes nothing.
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

/** A newer badge push replaces an older one APNs still holds. */
const APNS_BADGE_COLLAPSE_ID = "badge";

/**
 * Badge-only push. APNs requires push type `alert` for a badge payload; priority 5 does not wake
 * the app. `0` clears the badge.
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
