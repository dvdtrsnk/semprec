import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { GOOGLE_TOKEN_URL } from "@semprec/data";

/**
 * Issue #1739: the deployment's Cloud Pub/Sub configuration for Gmail push — the topic `users.watch`
 * publishes to, the pull subscription the one dispatcher reads, and the application's own Google service
 * account, whose access token authenticates the Pub/Sub calls (a user's Gmail grant has no Pub/Sub scope).
 */
export interface GmailPubSubConfig {
  /** `projects/<project>/topics/<topic>`. */
  topicName: string;
  /** `projects/<project>/subscriptions/<subscription>`. */
  subscriptionName: string;
  /** A Pub/Sub access token of the service account, reused until shortly before it expires. */
  getPubSubAccessToken(): Promise<string>;
}

/** The configuration, or `null` and why it is incomplete; `reason` names keys, never a value. */
export type GmailPubSubConfigResult = { config: GmailPubSubConfig; reason: null } | { config: null; reason: string };

const TOPIC_PATTERN = /^projects\/[^/\s]+\/topics\/[^/\s]+$/;
const SUBSCRIPTION_PATTERN = /^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/;
const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
/** Google issues a service-account token for at most an hour; the assertion asks for that. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/** A cached token is replaced this long before it expires, so no request carries one about to lapse. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const serviceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().min(1),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * `JSON.parse`, with `undefined` for text that is not JSON. V8's `SyntaxError` message quotes the start of
 * the input, which for a token response can be the token itself, so that error is not passed on.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * The key file errors that mean the configured path cannot be used, each with a fixed category for the
 * reason; any other failure of the read is unexpected and propagates as it is. `ERR_INVALID_ARG_VALUE` is
 * Node's refusal of a path containing a null byte.
 */
const UNREADABLE_KEY_PATH_CATEGORIES: Readonly<Record<string, string>> = {
  ENOENT: "does not exist",
  ENOTDIR: "does not exist",
  EACCES: "is not readable",
  EPERM: "is not readable",
  EISDIR: "is a directory",
  ENAMETOOLONG: "is not a valid path",
  ERR_INVALID_ARG_VALUE: "is not a valid path",
};

function unreadableKeyPathCategory(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return undefined;
  return Object.hasOwn(UNREADABLE_KEY_PATH_CATEGORIES, error.code)
    ? UNREADABLE_KEY_PATH_CATEGORIES[error.code]
    : undefined;
}

/**
 * Whether `error` is OpenSSL's decoder refusing the key material given to `createPrivateKey`: it carries
 * `ERR_OSSL_UNSUPPORTED` and an OpenSSL error stack, as for text that is no key at all, a truncated or
 * badly encoded PEM, or a public key.
 */
function isUndecodableKeyMaterial(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "ERR_OSSL_UNSUPPORTED" && "opensslErrorStack" in error
  );
}

/**
 * `primary` itself when no cleanup failed; otherwise an `AggregateError` that lists `primary` first, then the
 * cleanup failures in order, keeps `primary` as its `cause` and repeats only its fixed message.
 */
function withCleanupFailures(primary: unknown, cleanupFailures: readonly unknown[]): unknown {
  if (cleanupFailures.length === 0) return primary;
  const message = primary instanceof Error ? primary.message : "The Pub/Sub token request failed";
  return new AggregateError([primary, ...cleanupFailures], message, { cause: primary });
}

/** An operation's outcome by the request deadline: its value, or `settled: false` when the deadline came first. */
type ByDeadline<T> = { settled: true; value: T } | { settled: false };

/**
 * Waits for `operation` until `deadline` aborts, and rethrows its failure when it fails first. When the deadline
 * comes first the operation is not settled: it stays pending, observed so that its later rejection is not an
 * unhandled one, and the caller reports it as unsettled. The abort listener is removed on every exit.
 */
async function byDeadline<T>(operation: Promise<T>, deadline: AbortSignal): Promise<ByDeadline<T>> {
  const observed = operation.then((value): ByDeadline<T> => ({ settled: true, value }));
  // Observed here as well as by the race below, so a rejection after the deadline is never unhandled.
  observed.catch(() => undefined);
  if (deadline.aborted) return { settled: false };
  let onAbort: (() => void) | undefined;
  const expired = new Promise<ByDeadline<T>>((resolve) => {
    onAbort = () => resolve({ settled: false });
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([observed, expired]);
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort);
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Reads a response body up to `maxBytes`, every read bounded by the request's `deadline`; a longer body is
 * refused rather than buffered, and its stream is cancelled. A read still pending at the deadline fails with
 * the deadline's reason; its stream is asked to cancel without waiting further, and the response is reported
 * as not settled. The reader's lock is released on every path. A read, size or deadline failure stays the
 * primary error; a failed or unsettled cancel and a failed release are attached after it
 * (`withCleanupFailures`), and one after a complete read fails the read too, since the body was not settled.
 */
async function readBoundedText(response: Response, maxBytes: number, deadline: AbortSignal): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new Error("The Pub/Sub token response has no body");
  const decoder = new TextDecoder();
  const cleanupFailures: unknown[] = [];
  let failed = false;
  let failure: unknown;
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const read = await byDeadline(reader.read(), deadline);
      if (!read.settled) {
        failed = true;
        failure = deadline.reason;
        // Asked to stop, not awaited: the deadline has passed, so this response is reported as unsettled.
        reader.cancel(deadline.reason).catch(() => undefined);
        cleanupFailures.push(new Error("The Pub/Sub token response was not settled before its deadline"));
        break;
      }
      const { done, value } = read.value;
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        failed = true;
        failure = new Error("The Pub/Sub token response exceeded its size cap");
        await settleCancel(reader.cancel(), deadline, cleanupFailures);
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (failed) throw withCleanupFailures(failure, cleanupFailures);
  if (cleanupFailures.length > 0) {
    throw withCleanupFailures(new Error("The Pub/Sub token response could not be settled"), cleanupFailures);
  }
  return text + decoder.decode();
}

/**
 * Waits for a body cancellation until the request `deadline`. A rejected cancellation, and one still pending
 * at the deadline, are recorded in `cleanupFailures`; neither counts as settled.
 */
async function settleCancel(cancel: Promise<void>, deadline: AbortSignal, cleanupFailures: unknown[]): Promise<void> {
  try {
    const cancelled = await byDeadline(cancel, deadline);
    if (!cancelled.settled) {
      cleanupFailures.push(new Error("The Pub/Sub token response's cancellation did not settle before its deadline"));
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
}

/**
 * The service account's token source: an RS256-signed JWT assertion (`node:crypto`) exchanged at Google's
 * token endpoint, cached until `TOKEN_EXPIRY_MARGIN_MS` before its expiry. Concurrent callers while a
 * request is in flight share it; a failed request is not cached, so the next call asks again. The fetch,
 * every body read and any body cancellation share one `TOKEN_REQUEST_TIMEOUT_MS` deadline; work still
 * pending at it fails the request and is reported as not settled. No error message carries the key, the
 * assertion or a token.
 */
function createServiceAccountTokenSource(clientEmail: string, privateKey: KeyObject): () => Promise<string> {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function requestToken(): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(
      JSON.stringify({
        iss: clientEmail,
        scope: PUBSUB_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const assertion = `${signingInput}.${base64Url(sign("RSA-SHA256", Buffer.from(signingInput), privateKey))}`;
    // One deadline for the whole request: the fetch, every body read and any cancellation.
    const deadline = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: deadline,
    });
    if (!response.ok) {
      const primary = new Error(`The Pub/Sub token request failed with status ${response.status}`);
      const cleanupFailures: unknown[] = [];
      if (response.body) await settleCancel(response.body.cancel(), deadline, cleanupFailures);
      throw withCleanupFailures(primary, cleanupFailures);
    }
    const body = await readBoundedText(response, MAX_TOKEN_RESPONSE_BYTES, deadline);
    const parsed = tokenResponseSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new Error("The Pub/Sub token response is not a token");
    cached = { token: parsed.data.access_token, expiresAtMs: Date.now() + parsed.data.expires_in * 1000 };
    return parsed.data.access_token;
  }

  return () => {
    if (cached && Date.now() < cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS) return Promise.resolve(cached.token);
    inFlight ??= requestToken().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Reads `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_SUBSCRIPTION` and `GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH`,
 * checks the two resource names' formats, and reads and parses the service account key file once, here,
 * at startup. A missing key, a malformed resource name, a key path that does not exist, is not readable, is
 * a directory or is not a valid path, and a file that is not an RSA service account key give
 * `{ config: null, reason }`; the reason names the key and a fixed category, never a value, a path or the
 * file's content. Any other failure of the read or of decoding the key propagates. Runtime token failures
 * are `getPubSubAccessToken()` rejections, never a `null` configuration.
 */
export async function loadGmailPubSubConfig(env: NodeJS.ProcessEnv): Promise<GmailPubSubConfigResult> {
  const topicName = env.GMAIL_PUBSUB_TOPIC;
  const subscriptionName = env.GMAIL_PUBSUB_SUBSCRIPTION;
  const keyPath = env.GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH;
  const missing = (
    [
      ["GMAIL_PUBSUB_TOPIC", topicName],
      ["GMAIL_PUBSUB_SUBSCRIPTION", subscriptionName],
      ["GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH", keyPath],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !topicName || !subscriptionName || !keyPath) {
    return { config: null, reason: `missing ${missing.join(", ")}` };
  }
  if (!TOPIC_PATTERN.test(topicName)) {
    return { config: null, reason: "GMAIL_PUBSUB_TOPIC is not projects/<project>/topics/<topic>" };
  }
  if (!SUBSCRIPTION_PATTERN.test(subscriptionName)) {
    return {
      config: null,
      reason: "GMAIL_PUBSUB_SUBSCRIPTION is not projects/<project>/subscriptions/<subscription>",
    };
  }
  let keyText: string;
  try {
    keyText = await readFile(keyPath, "utf8");
  } catch (error) {
    const category = unreadableKeyPathCategory(error);
    if (category === undefined) throw error;
    return { config: null, reason: `GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH ${category}` };
  }
  let privateKey: KeyObject;
  const notAKey: GmailPubSubConfigResult = {
    config: null,
    reason: "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a service account key",
  };
  const key = serviceAccountKeySchema.safeParse(parseJson(keyText));
  if (!key.success) return notAKey;
  try {
    privateKey = createPrivateKey(key.data.private_key);
  } catch (error) {
    // No detail is passed on: the reason is fixed, whatever the key material was.
    if (isUndecodableKeyMaterial(error)) return notAKey;
    throw error;
  }
  // RS256 signs with an RSA key; Google issues service account keys as RSA.
  if (privateKey.asymmetricKeyType !== "rsa") return notAKey;
  return {
    config: {
      topicName,
      subscriptionName,
      getPubSubAccessToken: createServiceAccountTokenSource(key.data.client_email, privateKey),
    },
    reason: null,
  };
}
