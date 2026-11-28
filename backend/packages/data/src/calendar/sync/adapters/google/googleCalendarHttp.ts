// Requests to Google Calendar API v3: a bearer token per request, a deadline per request combined with the pass's
// signal, a size cap on every body read, and Google's refusals mapped onto the calendar sync's error classes. No
// error message or log line carries provider text, a token or a calendar id (Google's calendar ids are addresses).
import { z } from "zod";
import {
  CalendarSyncConsentRequiredError,
  CalendarSyncEventConflictError,
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
} from "../../adapter.js";

const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";

const REQUEST_TIMEOUT_MS = 30_000;
/** Far more than a page of 250 events takes. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A refusal's body is read only for its reason codes. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** Google's `error.errors[].reason` and `error.details[].reason` values that mean the grant lacks the calendar scope. */
const CONSENT_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
]);

/** Keeps one access token for the adapter's lifetime; `invalidate` makes the next `get` refresh it. */
export interface GoogleAccessTokenSource {
  get(): Promise<string>;
  invalidate(): void;
}

interface GoogleRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path below the API base, already encoded. */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  ifMatch?: string | null;
}

/** A status the caller handles itself is returned with no body; every other non-2xx status throws. */
interface GoogleResponse {
  status: number;
  body: unknown;
}

export class GoogleCalendarHttp {
  constructor(
    private readonly tokens: GoogleAccessTokenSource,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * A 401 refreshes the token once and repeats the request; a second 401 means the grant is gone. `handled` lists
   * statuses returned to the caller (with a `null` body) instead of thrown.
   */
  async request(request: GoogleRequest, signal: AbortSignal, handled: readonly number[] = []): Promise<GoogleResponse> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(request, signal);
      if (response.status === 401) {
        await discard(response);
        if (attempt === 0) {
          this.tokens.invalidate();
          continue;
        }
        throw new CalendarSyncReauthorizationRequiredError("Google Calendar refused the refreshed access token");
      }
      if (handled.includes(response.status)) {
        await discard(response);
        return { status: response.status, body: null };
      }
      if (!response.ok) throw await refusal(response);
      if (response.status === 204) {
        await discard(response);
        return { status: 204, body: null };
      }
      return { status: response.status, body: await readJson(response, signal) };
    }
  }

  private async send(request: GoogleRequest, signal: AbortSignal): Promise<Response> {
    const token = await this.tokens.get();
    const url = `${GOOGLE_CALENDAR_API_BASE_URL}${request.path}${request.query ? `?${request.query.toString()}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    if (request.ifMatch) headers["If-Match"] = request.ifMatch;
    try {
      return await this.fetchImpl(url, {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        redirect: "error",
      });
    } catch (error) {
      // The failure can name the request URL (a calendar address) and is not passed on.
      void error;
      throw transportFailure(signal);
    }
  }
}

function transportFailure(signal: AbortSignal): CalendarSyncProviderError {
  return signal.aborted
    ? new CalendarSyncProviderError("timeout", "The calendar sync pass ran out of time during a Google request")
    : new CalendarSyncProviderError("providerUnavailable", "A Google Calendar request failed in transport");
}

/** Validates a parsed body against `schema`; a mismatch is `invalidResponse`. */
export function parseGoogleBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new CalendarSyncProviderError("invalidResponse", "A Google Calendar response has an unexpected shape");
  }
  return parsed.data;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // Nothing more is read from this response; a failed cancel only leaves the socket to the runtime.
    void error;
  }
}

/** Reads at most `limit` bytes; `null` when the body is longer. */
async function readText(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      // The body is complete or abandoned either way; a cancel failure must not replace the read's outcome.
      void error;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  let text: string | null;
  try {
    text = await readText(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    void error;
    throw transportFailure(signal);
  }
  if (text === null) {
    throw new CalendarSyncProviderError("invalidResponse", "A Google Calendar response is over the size limit");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    void error;
    throw new CalendarSyncProviderError("invalidResponse", "A Google Calendar response is not JSON");
  }
}

const reasonList = z.array(z.object({ reason: z.string().optional() })).optional();
const errorBodySchema = z.object({ error: z.object({ errors: reasonList, details: reasonList }) });

/** The machine-readable reasons of a Google error body; its messages are never read. */
async function refusalReasons(response: Response): Promise<Set<string>> {
  let text: string | null;
  try {
    text = await readText(response, MAX_ERROR_BODY_BYTES);
  } catch (error) {
    // The status alone still classifies the refusal.
    void error;
    return new Set();
  }
  let body: unknown;
  try {
    body = text === null ? null : JSON.parse(text);
  } catch (error) {
    void error;
    return new Set();
  }
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return new Set();
  const entries = [...(parsed.data.error.errors ?? []), ...(parsed.data.error.details ?? [])];
  return new Set(entries.flatMap((entry) => (entry.reason === undefined ? [] : [entry.reason])));
}

async function refusal(response: Response): Promise<Error> {
  const { status } = response;
  if (status === 412) {
    await discard(response);
    return new CalendarSyncEventConflictError(
      "Google Calendar refused the write: the Event changed since the stored etag",
    );
  }
  const reasons = status === 403 || status === 429 ? await refusalReasons(response) : new Set<string>();
  if (status !== 403 && status !== 429) await discard(response);
  const scopeChallenge = /insufficient_scope/i.test(response.headers.get("www-authenticate") ?? "");
  if (status === 403 && (scopeChallenge || [...reasons].some((reason) => CONSENT_REASONS.has(reason)))) {
    return new CalendarSyncConsentRequiredError("Google Calendar refused the request: the grant lacks calendar access");
  }
  if (status === 429 || (status === 403 && [...reasons].some((reason) => RATE_LIMIT_REASONS.has(reason)))) {
    return new CalendarSyncProviderError("rateLimited", "Google Calendar rate-limited the request");
  }
  if (status >= 500) {
    return new CalendarSyncProviderError("providerUnavailable", `Google Calendar answered with status ${status}`);
  }
  return new Error(`Google Calendar refused the request with status ${status}`);
}
