import { z } from "zod";
import { createLogger } from "@semprec/shared";

const logger = createLogger("ares-client");

/**
 * A constant, never a setting or user input, so the connect-time address check for user-stored URLs
 * is not applied; the egress filter lets the public host through.
 */
export const ARES_BASE_URL = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

/** From the request until its body is read. */
export const ARES_TIMEOUT_MS = 3000;

/** An answer for one company is a few kilobytes. */
export const ARES_MAX_RESPONSE_BYTES = 64 * 1024;

/** ARES names are at most 255 characters. */
const MAX_NAME_LENGTH = 500;

const ICO_PATTERN = /^\d{8}$/;

export interface AresCompany {
  ico: string;
  name: string;
}

export interface AresClient {
  /**
   * `ico` is eight digits; `null` when ARES does not know the number. Every other outcome throws an
   * `AresLookupError`.
   */
  lookupCompanyByIco(ico: string): Promise<AresCompany | null>;
}

export type AresLookupFailure = "invalidIco" | "timeout" | "network" | "status" | "tooLarge" | "malformed";

/**
 * The message and fields carry the reason and HTTP status only, never the number or anything the
 * register answered, so the reason may be logged as is.
 */
export class AresLookupError extends Error {
  readonly reason: AresLookupFailure;
  readonly status: number | undefined;

  constructor(reason: AresLookupFailure, options: { status?: number; cause?: unknown } = {}) {
    super(`ARES lookup failed: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AresLookupError";
    this.reason = reason;
    this.status = options.status;
  }
}

/** ARES sends many more fields. */
const aresAnswerSchema = z.object({ ico: z.string(), obchodniJmeno: z.string() });

/** A failing cancel is logged and dropped, never replacing the failure that caused it. */
async function cancelQuietly(stream: { cancel(): Promise<void> }): Promise<void> {
  try {
    await stream.cancel();
  } catch (error) {
    logger.warn({ name: error instanceof Error ? error.name : "unknown" }, "Could not cancel an ARES body");
  }
}

/**
 * A longer body is refused and its stream cancelled. Aborting the request's signal fails the
 * stream: a timeout when `deadline` has fired, a network failure otherwise.
 */
async function readBoundedBody(response: Response, deadline: AbortSignal): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new AresLookupError("malformed");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new AresLookupError(deadline.aborted ? "timeout" : "network", { cause: error });
    }
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > ARES_MAX_RESPONSE_BYTES) {
      await cancelQuietly(reader);
      throw new AresLookupError("tooLarge");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseAnswer(text: string, ico: string): AresCompany {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AresLookupError("malformed", { cause: error });
  }
  const parsed = aresAnswerSchema.safeParse(json);
  const name = parsed.success ? parsed.data.obchodniJmeno.trim() : "";
  // An answer for another number is not the answer to this lookup.
  if (!parsed.success || parsed.data.ico !== ico || name === "" || name.length > MAX_NAME_LENGTH) {
    throw new AresLookupError("malformed");
  }
  return { ico, name };
}

/**
 * A deadline of `ARES_TIMEOUT_MS` for the whole answer, a body cap, and no redirect followed. A 404
 * is `null`; every other failure is an `AresLookupError` with its reason.
 */
export function createAresHttpClient({ fetch: fetchImpl }: { fetch?: typeof fetch } = {}): AresClient {
  return {
    async lookupCompanyByIco(ico) {
      if (!ICO_PATTERN.test(ico)) throw new AresLookupError("invalidIco");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ARES_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          // The global `fetch` is read at the call, not when the client is built.
          response = await (fetchImpl ?? fetch)(`${ARES_BASE_URL}/ekonomicke-subjekty/${ico}`, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "error",
            signal: controller.signal,
          });
        } catch (error) {
          throw new AresLookupError(controller.signal.aborted ? "timeout" : "network", { cause: error });
        }
        if (response.status === 404) {
          if (response.body) await cancelQuietly(response.body);
          return null;
        }
        if (!response.ok) {
          if (response.body) await cancelQuietly(response.body);
          throw new AresLookupError("status", { status: response.status });
        }
        return parseAnswer(await readBoundedBody(response, controller.signal), ico);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
