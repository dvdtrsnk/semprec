import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for the mail module's draft routes under `/api/mail/drafts`: create, update
 * with the version last read, discard and send. A failure carries the backend's own
 * `error.message`, so compose can say what was refused (an unregistered From address, a stale
 * version, an SMTP login the server could not complete) rather than only a status code.
 */

export const MAIL_DRAFT_MODES = ["new", "reply", "replyAll", "forward"] as const;
export type MailDraftMode = (typeof MAIL_DRAFT_MODES)[number];

const recipientSchema = z.object({ address: z.string(), name: z.string() });

/** `name` is an empty string when the address has no display name. */
export type MailDraftRecipient = z.infer<typeof recipientSchema>;

/** The fields of the backend's `EmailDraftView` that compose reads; the rest of the view is not parsed. */
const emailDraftSchema = z.object({
  id: z.string(),
  mailboxId: z.string(),
  from: z.string(),
  to: z.array(recipientSchema),
  cc: z.array(recipientSchema),
  bcc: z.array(recipientSchema),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().nullable(),
  mode: z.enum(MAIL_DRAFT_MODES),
  sourceEmailId: z.string().nullable(),
  /** Sent back as `ifVersion` on the next update. */
  version: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().nullable(),
});

export type EmailDraft = z.infer<typeof emailDraftSchema>;

const sentMailDraftSchema = z.object({
  emailId: z.string(),
  threadId: z.string(),
  sentAt: z.string(),
  mailbox: z.object({ id: z.string(), name: z.string() }),
});

export type SentMailDraft = z.infer<typeof sentMailDraftSchema>;

const discardedSchema = z.object({ id: z.string() });

const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

export interface MailDraftFields {
  /** A plain address, which must be one the draft's mailbox registers. */
  from: string;
  to: MailDraftRecipient[];
  cc: MailDraftRecipient[];
  bcc: MailDraftRecipient[];
  subject: string;
  body: string;
}

/**
 * A `new` draft carries all of its content. A reply, reply-all or forward names its source
 * message instead: the backend computes sender, recipients, subject, thread and threading
 * headers from it and appends the quote to `body`.
 */
export type CreateMailDraftRequest =
  | ({ mailboxId: string; mode: "new"; threadId: string | null } & MailDraftFields)
  | { mailboxId: string; mode: Exclude<MailDraftMode, "new">; sourceEmailId: string; body: string };

export interface MailDraftOperations {
  create(request: CreateMailDraftRequest): Promise<EmailDraft>;
  /** Writes the given fields only; a `version` other than the draft's current one is refused with 409. */
  update(draftId: string, version: string, fields: Partial<MailDraftFields>): Promise<EmailDraft>;
  discard(draftId: string): Promise<void>;
  /** A refused send leaves the draft unsent and unchanged. */
  send(draftId: string): Promise<SentMailDraft>;
}

export interface MailDraftOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Statuses that answer "this resource is not here for you", so a retry only repeats the answer. */
const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export function createMailDraftOperations(options: MailDraftOperationsOptions): MailDraftOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T extends z.ZodType>(
    schema: T,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        credentials: "same-origin",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
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

  const draftPath = (draftId: string) => `/mail/drafts/${encodeURIComponent(draftId)}`;

  return {
    create(createRequest) {
      return request(emailDraftSchema, "/mail/drafts", "POST", createRequest);
    },

    update(draftId, version, fields) {
      return request(emailDraftSchema, draftPath(draftId), "PATCH", { ifVersion: version, ...fields });
    },

    async discard(draftId) {
      await request(discardedSchema, draftPath(draftId), "DELETE");
    },

    send(draftId) {
      return request(sentMailDraftSchema, `${draftPath(draftId)}/send`, "POST");
    },
  };
}

/**
 * A non-2xx answer. The message is the backend's `error.message` when the body carries one;
 * otherwise it names the path and status.
 */
async function failure(path: string, response: Response): Promise<OperationError> {
  let message = `Request to ${path} failed with ${response.status}`;
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) message = parsed.data.error.message;
  } catch {
    // A body that is not JSON carries no message; the status-based one above is reported instead.
  }
  return new OperationError(
    UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
    message,
    response.status,
  );
}

function unexpectedResponse(path: string): OperationError {
  return new OperationError("retryable", `Unexpected response from ${path}`);
}
