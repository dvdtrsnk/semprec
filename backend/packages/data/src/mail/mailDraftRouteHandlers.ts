// HTTP routes of Semprec mail drafts. Each handler parses and bounds the request, runs one `draft.ts` operation in one
// transaction and answers its view.
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import {
  createEmailDraftInMailbox,
  discardEmailDraft,
  readEmailDraft,
  updateEmailDraft,
  type EmailDraftView,
  type MailDraftWriteContext,
} from "./draft.js";
import { attachFileToDraft, detachFileFromDraft } from "./mailDraftAttachments.js";
import {
  requireSendAdapters,
  sendMailDraft,
  type MailDraftSendRouteDependencies,
  type SentMailDraft,
} from "./mailDraftSend.js";

export type { MailDraftSendRouteDependencies };
import { createPrefilledEmailDraft, isPrefilledDraftMode } from "./mailDraftPrefill.js";
import {
  draftAddress as address,
  draftBody as body,
  draftRecipients as recipients,
  draftSubject as subject,
} from "./mailDraftFields.js";
import { MAIL_DRAFT_MODES } from "./mailDraftsStore.js";

/** Prefilled modes compute most fields, so they are optional here; `newDraftFieldsSchema` requires them for `new`. */
const createBodySchema = z
  .object({
    mailboxId: z.uuid(),
    from: address.optional(),
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: subject.optional(),
    body: body.optional(),
    threadId: z.uuid().nullable().default(null),
    mode: z.enum(MAIL_DRAFT_MODES).default("new"),
    sourceEmailId: z.uuid().nullable().default(null),
  })
  .strict();

const newDraftFieldsSchema = z.object({
  from: address,
  to: recipients,
  cc: recipients,
  bcc: recipients,
  subject,
  body,
});

const updateBodySchema = z
  .object({
    ifVersion: z.string().min(1).max(64),
    mailboxId: z.uuid().optional(),
    from: address.optional(),
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: subject.optional(),
    body: body.optional(),
    threadId: z.uuid().nullable().optional(),
    mode: z.enum(MAIL_DRAFT_MODES).optional(),
    sourceEmailId: z.uuid().nullable().optional(),
  })
  .strict();

/** Names the first failing field. No message repeats a value of the body. */
function invalidBody(error: z.ZodError): ValidationError {
  const field = error.issues[0]?.path[0];
  return new ValidationError("The draft body is invalid", typeof field === "string" ? { field } : undefined);
}

interface DraftRouteContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** The user's locale, in which the quote of a reply is written. */
interface DraftCreateRouteContext extends DraftRouteContext {
  identity: { user: { id: string; locale: string } };
}

type DraftRouteResult<T> = Promise<{ status: number; body: T }>;

/** A malformed id names no draft, so it gets the same 404 as an unknown one. */
function draftIdOf(ctx: DraftRouteContext): string {
  const id = z.uuid().safeParse(ctx.params.id);
  if (!id.success) throw new NotFoundError("Draft not found");
  return id.data;
}

function writeContext(
  ctx: DraftRouteContext,
  queueAffinity: MailDraftWriteContext["queueAffinity"],
): MailDraftWriteContext {
  // A REST session is always a person; the writer is derived here, never read from the request.
  return { writer: { writerKind: "user" }, actingUserId: ctx.identity.user.id, queueAffinity };
}

/**
 * `POST /api/mail/drafts`: creates the draft and answers 201. Unknown keys, malformed addresses, a subject with a line
 * break and over 100 recipients are 400s.
 *
 * With `mode` `reply`, `replyAll` or `forward`, `sourceEmailId` is required and `from`, `to`, `cc`, `bcc`, `subject`
 * and `threadId` are computed from the source (request values are ignored); `body` is the person's own text, followed
 * by the quote.
 */
export function createMailDraftCreateRouteHandler(pool: Pool, dependencies: MailDraftAttachmentRouteDependencies = {}) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftCreateRouteContext): DraftRouteResult<EmailDraftView> => {
    const parsed = createBodySchema.safeParse(ctx.body);
    if (!parsed.success) throw invalidBody(parsed.error);
    const { mailboxId, sourceEmailId, mode, threadId, ...fields } = parsed.data;
    if (isPrefilledDraftMode(mode)) {
      if (sourceEmailId === null) {
        throw new ValidationError("The draft body is invalid", { field: "sourceEmailId" });
      }
      const uploadLimitBytes = mode === "forward" ? requireUploadLimit(dependencies) : undefined;
      const prefilled = await withTransaction(pool, (client) =>
        createPrefilledEmailDraft(
          client,
          {
            mailboxItemId: mailboxId,
            sourceEmailItemId: sourceEmailId,
            mode,
            locale: ctx.identity.user.locale,
            body: fields.body ?? "",
            uploadLimitBytes,
          },
          writeContext(ctx, queueAffinity),
        ),
      );
      return { status: 201, body: prefilled };
    }
    const newFields = newDraftFieldsSchema.safeParse(fields);
    if (!newFields.success) throw invalidBody(newFields.error);
    const draft = await withTransaction(pool, (client) =>
      createEmailDraftInMailbox(
        client,
        { ...newFields.data, threadId, mode, mailboxItemId: mailboxId, sourceEmailItemId: sourceEmailId },
        writeContext(ctx, queueAffinity),
      ),
    );
    return { status: 201, body: draft };
  };
}

/** `GET /api/mail/drafts/:id`. */
export function createMailDraftReadRouteHandler(pool: Pool) {
  return async (ctx: DraftRouteContext): DraftRouteResult<EmailDraftView> => {
    const draftId = draftIdOf(ctx);
    return { status: 200, body: await withTransaction(pool, (client) => readEmailDraft(client, draftId)) };
  };
}

/** `PATCH /api/mail/drafts/:id`: `ifVersion` is the `updatedAt` the caller read; absent fields keep their value. */
export function createMailDraftUpdateRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<EmailDraftView> => {
    const draftId = draftIdOf(ctx);
    const parsed = updateBodySchema.safeParse(ctx.body);
    if (!parsed.success) throw invalidBody(parsed.error);
    const { mailboxId, sourceEmailId, ...fields } = parsed.data;
    const draft = await withTransaction(pool, (client) =>
      updateEmailDraft(
        client,
        { ...fields, draftItemId: draftId, mailboxItemId: mailboxId, sourceEmailItemId: sourceEmailId },
        writeContext(ctx, queueAffinity),
      ),
    );
    return { status: 200, body: draft };
  };
}

const attachBodySchema = z.object({ fileItemId: z.uuid() }).strict();

/** The custom-route container members the attach route reads; `CustomRouteDependencies` is assignable to it. */
export interface MailDraftAttachmentRouteDependencies {
  /** `MAX_FILE_SIZE_MB` in bytes: the draft attachment limit for a mailbox without a provider limit. */
  maxFileSizeBytes?: number;
}

/**
 * A root without the limit fails with a plain error, not a `ChokePointError`: it is missing deployment configuration,
 * so the adapter logs it and answers a generic 500.
 */
function requireUploadLimit(dependencies: MailDraftAttachmentRouteDependencies): number {
  const limit = dependencies.maxFileSizeBytes;
  if (limit === undefined) {
    throw new Error('custom route dependency "maxFileSizeBytes" is not configured by the composition root');
  }
  return limit;
}

/**
 * `POST /api/mail/drafts/:id/attachments` with `{ fileItemId }`: attaches the file and answers 200 with the draft. A
 * non-UUID draft id is a 404; refusals are those of `attachFileToDraft`.
 */
export function createMailDraftAttachmentAddRouteHandler(
  pool: Pool,
  dependencies: MailDraftAttachmentRouteDependencies,
) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<EmailDraftView> => {
    const uploadLimitBytes = requireUploadLimit(dependencies);
    const draftId = draftIdOf(ctx);
    const parsed = attachBodySchema.safeParse(ctx.body);
    if (!parsed.success) throw invalidBody(parsed.error);
    const draft = await withTransaction(pool, (client) =>
      attachFileToDraft(
        client,
        { draftItemId: draftId, fileItemId: parsed.data.fileItemId, uploadLimitBytes },
        writeContext(ctx, queueAffinity),
      ),
    );
    return { status: 200, body: draft };
  };
}

/**
 * `DELETE /api/mail/drafts/:id/attachments/:fileItemId`: removes the attachment edge; the Files item stays. A non-UUID
 * id or an unattached file is a 404.
 */
export function createMailDraftAttachmentRemoveRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<EmailDraftView> => {
    const draftId = draftIdOf(ctx);
    const fileItemId = z.uuid().safeParse(ctx.params.fileItemId);
    if (!fileItemId.success) throw new NotFoundError("Attachment not found");
    const draft = await withTransaction(pool, (client) =>
      detachFileFromDraft(
        client,
        { draftItemId: draftId, fileItemId: fileItemId.data },
        writeContext(ctx, queueAffinity),
      ),
    );
    return { status: 200, body: draft };
  };
}

/**
 * `POST /api/mail/drafts/:id/send`: sends the draft as the user and answers `{ emailId, threadId, sentAt, mailbox }`.
 * The request body is not read. Refusals are those of `sendMailDraft`; a failure before or during delivery leaves the
 * draft unsent.
 */
export function createMailDraftSendRouteHandler(pool: Pool, dependencies: MailDraftSendRouteDependencies) {
  return async (ctx: DraftRouteContext): DraftRouteResult<SentMailDraft> => {
    const adapters = requireSendAdapters(dependencies);
    const draftId = draftIdOf(ctx);
    return { status: 200, body: await sendMailDraft(pool, draftId, adapters) };
  };
}

/** `DELETE /api/mail/drafts/:id`: discards the draft and answers its id. */
export function createMailDraftDiscardRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<{ id: string }> => {
    const draftId = draftIdOf(ctx);
    await withTransaction(pool, (client) => discardEmailDraft(client, draftId, writeContext(ctx, queueAffinity)));
    return { status: 200, body: { id: draftId } };
  };
}
