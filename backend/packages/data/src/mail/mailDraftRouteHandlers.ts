// Owns the four HTTP routes of Semprec mail drafts (issue gh-1867): create, read, update and discard. The
// handlers parse and bound the request, run one operation of `draft.ts` in one transaction and answer its view.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-09-10-side-effects-follow-the-commit.md
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
import { sendMailDraft, type SentMailDraft } from "./mailDraftSend.js";
import { createPrefilledEmailDraft, isPrefilledDraftMode } from "./mailDraftPrefill.js";
import {
  draftAddress as address,
  draftBody as body,
  draftRecipients as recipients,
  draftSubject as subject,
} from "./mailDraftFields.js";
import { MAIL_DRAFT_MODES } from "./mailDraftsStore.js";
import type { MailSendAdapterFactory } from "./send.js";

/**
 * The create body as it is first read: every field a prefilled mode computes is optional here. A `new` draft takes
 * those fields as given and `newDraftFieldsSchema` then requires them.
 */
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

/** The fields of a `new` draft, which no source message can supply. */
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

/** The first field a body failed on, for the 400. No message repeats a value of the body. */
function invalidBody(error: z.ZodError): ValidationError {
  const field = error.issues[0]?.path[0];
  return new ValidationError("The draft body is invalid", typeof field === "string" ? { field } : undefined);
}

interface DraftRouteContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** The create route also reads the locale of the user, in which the quote of a reply is written. */
interface DraftCreateRouteContext extends DraftRouteContext {
  identity: { user: { id: string; locale: string } };
}

type DraftRouteResult<T> = Promise<{ status: number; body: T }>;

/** `items.id` is a uuid: a malformed id names no draft, so it gets the same 404 as an unknown one. */
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
 * `POST /api/mail/drafts` (issue gh-1867): creates the draft, its Drafts folder edge and its `mail_drafts` row in
 * one transaction and answers 201 with the draft. The body is `{ mailboxId, from, to, cc, bcc, subject, body }`
 * and may carry `threadId`, `mode` (default `new`) and `sourceEmailId`; any other key, an address that is no
 * address, a subject with a line break and a list of more than 100 recipients are 400s. The refusals of the
 * operation (`createEmailDraftInMailbox`) are its own.
 *
 * With `mode` `reply`, `replyAll` or `forward` (issue gh-1899) the body names the source message in `sourceEmailId`
 * (a 400 without it) and `from`, `to`, `cc`, `bcc`, `subject` and `threadId` are computed from it
 * (`createPrefilledEmailDraft`); a value the request gives for them is ignored. `body` is the person's own text, which
 * may be absent and then is empty, and the draft's body is that text followed by an empty line and the quote of the
 * source in the locale of the user. A forward's attachments are copied under the upload limit of the composition
 * root, which only a forward needs.
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

/** `GET /api/mail/drafts/:id` (issue gh-1867): the draft, or the 404 `readEmailDraft` describes. */
export function createMailDraftReadRouteHandler(pool: Pool) {
  return async (ctx: DraftRouteContext): DraftRouteResult<EmailDraftView> => {
    const draftId = draftIdOf(ctx);
    return { status: 200, body: await withTransaction(pool, (client) => readEmailDraft(client, draftId)) };
  };
}

/**
 * `PATCH /api/mail/drafts/:id` (issue gh-1867): the body is `ifVersion`, the `updatedAt` of the draft the caller
 * read, and any of the fields of the create body; a field that is absent keeps its value. It answers 200 with the
 * draft. The refusals are those of `updateEmailDraft`.
 */
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

/**
 * The members of the composition root's custom-route container the attach route reads
 * (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md). `semprec-api`'s
 * `CustomRouteDependencies` is assignable to it.
 */
export interface MailDraftAttachmentRouteDependencies {
  /**
   * `MAX_FILE_SIZE_MB` in bytes, the limit of the attachments of a draft in a mailbox that has no provider limit.
   * `createDispatcher` of `semprec-api` sets it (`services/semprec-api/src/app.ts`). The route has no limit of its
   * own to fall back on.
   */
  maxFileSizeBytes?: number;
}

/**
 * The upload limit the composition root configured. A root that configured none fails the request with a plain
 * error and not a `ChokePointError`, as docs/adr/2026-10-29-custom-route-composition-root-dependencies.md decides
 * for a member that is not set: the deployment is missing configuration, so the adapter logs the error and answers a
 * generic 500.
 */
function requireUploadLimit(dependencies: MailDraftAttachmentRouteDependencies): number {
  const limit = dependencies.maxFileSizeBytes;
  if (limit === undefined) {
    throw new Error('custom route dependency "maxFileSizeBytes" is not configured by the composition root');
  }
  return limit;
}

/**
 * `POST /api/mail/drafts/:id/attachments` with the body `{ fileItemId }` (issue gh-1895): attaches the Files item to
 * the draft and answers 200 with the draft, whose `attachments` lists it. A draft id that is no UUID is a 404 and a
 * body that is anything but that object a 400. The refusals are those of `attachFileToDraft`: 404 for an unknown
 * draft or file (another tenant's included), 409 for a draft that cannot be changed and 413
 * `mail_attachment_too_large` for attachments over the limit of the mailbox's provider.
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
 * `DELETE /api/mail/drafts/:id/attachments/:fileItemId` (issue gh-1895): removes the attachment edge and answers 200
 * with the draft. A draft id or file id that is no UUID names nothing and is a 404, as is a file that is not attached
 * to the draft. The Files item stays.
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
 * The members of the composition root's custom-route container the send route reads
 * (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md). `semprec-api`'s `CustomRouteDependencies` is
 * assignable to it.
 */
export interface MailDraftSendRouteDependencies {
  mailServerClients?: {
    /** The transports and the attachment storage `sendDraftEmail` takes; `createDispatcher` of `semprec-api` supplies them. */
    send?: MailSendAdapterFactory;
  };
}

/**
 * The send adapters the composition root configured. A root that configured none fails the request with a plain error
 * and not a `ChokePointError`, as docs/adr/2026-10-29-custom-route-composition-root-dependencies.md decides for a member
 * that is not set: the adapter logs it and answers a generic 500, and the draft stays as it was.
 */
function requireSendAdapters(dependencies: MailDraftSendRouteDependencies): MailSendAdapterFactory {
  const send = dependencies.mailServerClients?.send;
  if (send === undefined) {
    throw new Error('custom route dependency "mailServerClients.send" is not configured by the composition root');
  }
  return send;
}

/**
 * `POST /api/mail/drafts/:id/send` (issue gh-1896): sends the draft as the user (`sendMailDraft`) and answers 200
 * with `{ emailId, threadId, sentAt, mailbox: { id, name } }`. The request has no body that is read. A draft id that
 * is no UUID is a 404. The refusals and failures are those of `sendMailDraft`: 400 without a recipient, 403
 * `from_address_not_registered`, 404 for an unknown draft or mailbox (another tenant's included), 409
 * `mail_draft_already_sent` with `{ emailId, threadId }`, `mail_draft_not_editable`, `mail_reauthorization_required`
 * and `mail_sent_folder_missing`, 422 `mail_recipient_rejected`, and 400 `mail_auth_failed` and
 * `mail_server_unreachable` for the mail server. A failure before or during delivery leaves the draft unsent.
 */
export function createMailDraftSendRouteHandler(pool: Pool, dependencies: MailDraftSendRouteDependencies) {
  return async (ctx: DraftRouteContext): DraftRouteResult<SentMailDraft> => {
    const adapters = requireSendAdapters(dependencies);
    const draftId = draftIdOf(ctx);
    return { status: 200, body: await sendMailDraft(pool, draftId, adapters) };
  };
}

/** `DELETE /api/mail/drafts/:id` (issue gh-1867): discards the draft (`discardEmailDraft`) and answers 200 with its id. */
export function createMailDraftDiscardRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<{ id: string }> => {
    const draftId = draftIdOf(ctx);
    await withTransaction(pool, (client) => discardEmailDraft(client, draftId, writeContext(ctx, queueAffinity)));
    return { status: 200, body: { id: draftId } };
  };
}
