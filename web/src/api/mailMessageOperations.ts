import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for the mail module's per-message routes under `/api/mail/messages`: a
 * message's body and attachments (`GET …/content`, which answers a stored body as well as one
 * fetched from the provider on demand) and saving an attachment's bytes to Files
 * (`POST …/attachments/:attachmentId/save`). A saved attachment's bytes are served by
 * `GET /api/blobs/:blobId`.
 */

/** Why the backend could not fetch a message's content or an attachment's bytes from the provider. */
export const MAIL_CONTENT_UNAVAILABLE_REASONS = [
  "reauthorizationRequired",
  "providerUnreachable",
  "messageNotFound",
  "mailboxUnavailable",
  "attachmentTooLarge",
] as const;
export type MailContentUnavailableReason = (typeof MAIL_CONTENT_UNAVAILABLE_REASONS)[number];

const attachmentSchema = z.object({
  attachmentId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** `false` for an attachment of an indexed message whose bytes were never saved. */
  stored: z.boolean(),
  blobId: z.string().nullable(),
  fileItemId: z.string().nullable(),
});

export type MailMessageAttachment = z.infer<typeof attachmentSchema>;

const contentSchema = z.object({
  emailId: z.string(),
  contentState: z.enum(["full", "cached"]),
  bodyHtml: z.string(),
  bodyText: z.string(),
  fetchedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  attachments: z.array(attachmentSchema),
});

export type MailMessageContent = z.infer<typeof contentSchema>;

const savedAttachmentSchema = z.object({ fileItemId: z.string() });

export type SavedMailAttachment = z.infer<typeof savedAttachmentSchema>;

const errorBodySchema = z.object({ error: z.object({ code: z.string(), details: z.unknown().optional() }) });

const unavailableDetailsSchema = z.object({ reason: z.enum(MAIL_CONTENT_UNAVAILABLE_REASONS) });

/** The refusals these routes answer that a reader can act on, each distinct from a generic failure. */
export type MailMessageFailure =
  | { code: "contentUnavailable"; reason: MailContentUnavailableReason }
  | { code: "rateLimited"; retryAfterSeconds: number | null }
  | { code: "notFound" };

/**
 * A 409 `mail_content_unavailable`, a 429 `rate_limited` or a 404 `not_found`. Only a provider
 * that could not be reached and a throttle refusal are worth retrying as they are; the other
 * reasons need something to change first (a new sign-in, the account switched back on).
 */
export class MailMessageError extends OperationError {
  readonly failure: MailMessageFailure;

  constructor(failure: MailMessageFailure, status: number) {
    const retryable =
      failure.code === "rateLimited" ||
      (failure.code === "contentUnavailable" && failure.reason === "providerUnreachable");
    super(retryable ? "retryable" : "unavailable", `Mail message request failed: ${failure.code}`, status);
    this.name = "MailMessageError";
    this.failure = failure;
  }
}

export interface MailMessageOperations {
  /** The body (sanitized HTML and plain text) and the attachments; may ask the provider, so it can be slow. */
  getContent(emailId: string): Promise<MailMessageContent>;
  /** Stores the attachment's bytes as a Files item of the message, or answers the one that exists. */
  saveAttachment(emailId: string, attachmentId: string): Promise<SavedMailAttachment>;
  /** Where a stored attachment's bytes are opened or downloaded. */
  blobUrl(blobId: string): string;
}

export interface MailMessageOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Statuses that answer "this resource is not here for you", so a retry only repeats the answer. */
const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export function createMailMessageOperations(options: MailMessageOperationsOptions): MailMessageOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T extends z.ZodType>(schema: T, path: string, method: string): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, credentials: "same-origin" });
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) throw await failure(path, response);

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw unexpectedResponse(path);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw unexpectedResponse(path);
    return result.data;
  }

  const messagePath = (emailId: string) => `/mail/messages/${encodeURIComponent(emailId)}`;

  return {
    getContent(emailId) {
      return request(contentSchema, `${messagePath(emailId)}/content`, "GET");
    },

    saveAttachment(emailId, attachmentId) {
      return request(
        savedAttachmentSchema,
        `${messagePath(emailId)}/attachments/${encodeURIComponent(attachmentId)}/save`,
        "POST",
      );
    },

    blobUrl(blobId) {
      return `${baseUrl}/blobs/${encodeURIComponent(blobId)}`;
    },
  };
}

/** `Retry-After` in whole seconds; anything else (absent, a date, garbage) is unknown. */
function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  return header !== null && /^\d{1,9}$/.test(header.trim()) ? Number(header.trim()) : null;
}

async function failure(path: string, response: Response): Promise<OperationError> {
  if (response.status === 429) {
    return new MailMessageError({ code: "rateLimited", retryAfterSeconds: retryAfterSeconds(response) }, 429);
  }
  let body: z.infer<typeof errorBodySchema> | null = null;
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) body = parsed.data;
  } catch {
    // A body that is not JSON names no code; the status decides alone below.
  }
  if (response.status === 409 && body?.error.code === "mail_content_unavailable") {
    const details = unavailableDetailsSchema.safeParse(body.error.details);
    if (details.success) return new MailMessageError({ code: "contentUnavailable", reason: details.data.reason }, 409);
  }
  if (response.status === 404) return new MailMessageError({ code: "notFound" }, 404);
  return new OperationError(
    UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
    `Request to ${path} failed with ${response.status}`,
    response.status,
  );
}

function unexpectedResponse(path: string): OperationError {
  return new OperationError("retryable", `Unexpected response from ${path}`);
}
