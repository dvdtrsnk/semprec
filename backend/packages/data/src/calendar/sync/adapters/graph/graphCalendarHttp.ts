// Every request of the Graph calendar adapter: the bearer token, the pass's signal under a per-request deadline, a
// cap on each response, Graph's throttling answers, and the mapping of statuses onto the calendar sync's errors.
// Errors carry statuses only, never a URL, a token or provider text.
import {
  CalendarSyncConsentRequiredError,
  CalendarSyncEventConflictError,
  CalendarSyncProviderError,
  CalendarSyncReauthorizationRequiredError,
} from "../../adapter.js";

export const GRAPH_API_ROOT = "https://graph.microsoft.com/v1.0";

const REQUEST_TIMEOUT_MS = 30_000;
/** A page of 100 Events with plain-text bodies stays far below this. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Attempts of one request when Graph throttles it (429) or is briefly unavailable (503, 504). */
const MAX_ATTEMPTS = 3;
/** A longer `Retry-After` ends the pass as `rateLimited`; the queue retries it later. */
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 2_000;

/** A Graph status the adapter has no meaning for (400, 404 outside a delete, …); recorded as `unexpected`. */
export class GraphCalendarRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Microsoft Graph calendar request failed with status ${status}`);
    this.name = "GraphCalendarRequestError";
    this.status = status;
  }
}

function invalidResponse(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", "Microsoft Graph sent an unusable calendar response");
}

/**
 * Refuses any address but Graph's v1.0 API over HTTPS, so a `nextLink`, `deltaLink` or stored cursor never takes
 * the bearer token elsewhere.
 */
export function assertGraphUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidResponse();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== "graph.microsoft.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !parsed.pathname.startsWith("/v1.0/")
  ) {
    throw invalidResponse();
  }
  return parsed.toString();
}

/** Seconds or an HTTP date; `null` when absent or unreadable. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  if (/^\d{1,6}$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CalendarSyncProviderError("timeout"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CalendarSyncProviderError("timeout"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Drops a body nobody reads; a failure to do so cannot change the request's outcome. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // The status is already decided; an unreadable leftover body does not change it.
    void error;
  }
}

/** Reads at most `MAX_RESPONSE_BYTES`; a larger body is refused rather than buffered. */
async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        overflow = true;
        break;
      }
      chunks.push(value);
    }
  } catch (error) {
    void error;
    throw new CalendarSyncProviderError("providerUnavailable", "Microsoft Graph's response could not be read");
  } finally {
    try {
      await reader.cancel();
      reader.releaseLock();
    } catch (cleanupError) {
      // The body was read or refused already; releasing it cannot change that.
      void cleanupError;
    }
  }
  if (overflow) throw invalidResponse();
  return Buffer.concat(chunks).toString("utf8");
}

export interface GraphRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Added to the `Prefer` header every request sends. */
  prefer?: string;
  /** Statuses returned to the caller instead of thrown (410 for an expired delta, 404 for a gone Event). */
  tolerate?: readonly number[];
}

export interface GraphResponse {
  status: number;
  /** The parsed JSON body; `null` for an empty or tolerated response. */
  json: unknown;
}

/** Times in UTC and bodies as plain text, so no response carries a Windows zone or HTML. */
const PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

export class GraphCalendarHttp {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(request: GraphRequest, signal: AbortSignal): Promise<GraphResponse> {
    const url = assertGraphUrl(request.url);
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetchOnce(request, url, signal);
      if (request.tolerate?.includes(response.status)) {
        await discardBody(response);
        return { status: response.status, json: null };
      }
      if (response.ok) return { status: response.status, json: await this.jsonOf(response) };
      await discardBody(response);
      if (response.status === 429 || response.status === 503 || response.status === 504) {
        const wait = retryAfterMs(response) ?? DEFAULT_RETRY_AFTER_MS;
        if (attempt < MAX_ATTEMPTS && wait <= MAX_RETRY_AFTER_MS) {
          await sleep(wait, signal);
          continue;
        }
        throw new CalendarSyncProviderError(response.status === 429 ? "rateLimited" : "providerUnavailable");
      }
      throw this.failureOf(response.status);
    }
  }

  private async fetchOnce(request: GraphRequest, url: string, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw new CalendarSyncProviderError("timeout");
    // A refused refresh token surfaces as `MailReauthorizationRequiredError`, which the sync job maps itself.
    const token = await this.getAccessToken();
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Prefer: request.prefer === undefined ? PREFER : `${PREFER}, ${request.prefer}`,
          ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...request.headers,
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.any([signal, deadline]),
      });
    } catch (error) {
      void error;
      throw new CalendarSyncProviderError(
        signal.aborted || deadline.aborted ? "timeout" : "providerUnavailable",
        "Microsoft Graph could not be reached",
      );
    }
  }

  private async jsonOf(response: Response): Promise<unknown> {
    const text = await readBoundedText(response);
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invalidResponse();
    }
  }

  private failureOf(status: number): Error {
    if (status === 401) return new CalendarSyncReauthorizationRequiredError("Microsoft Graph refused the access token");
    if (status === 403) return new CalendarSyncConsentRequiredError("Microsoft Graph refused calendar access");
    if (status === 412)
      return new CalendarSyncEventConflictError("The Event changed at Microsoft since it was last synced");
    if (status >= 500) return new CalendarSyncProviderError("providerUnavailable");
    return new GraphCalendarRequestError(status);
  }
}
