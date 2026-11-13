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
import { MAIL_DRAFT_MODES } from "./mailDraftsStore.js";

const MAX_ADDRESS_LENGTH = 320;
const MAX_NAME_LENGTH = 320;
/** The longest header line RFC 5322 allows, which the subject has to fit. */
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 500_000;
/** The recipients of one list; a list longer than this is no person's mail. */
const MAX_RECIPIENTS = 100;

/** One address without whitespace or a comma, the same shape the mailbox connect route accepts. */
const ADDRESS_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
/** A control character (general category Cc, line breaks included) or an unpaired surrogate (Cs). */
const UNSTORABLE_HEADER_CHARACTER = /[\p{Cc}\p{Cs}]/u;
/** An unpaired surrogate (Cs), which `jsonb` refuses. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/** Postgres refuses U+0000 in `text` and `jsonb`, and `jsonb` refuses an unpaired surrogate. */
const isStorableBody = (value: string): boolean => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);

/** A value that reaches a header of the outgoing mail may hold no line break, or a client could inject a header. */
const headerText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !UNSTORABLE_HEADER_CHARACTER.test(value));
const address = z
  .string()
  .trim()
  .max(MAX_ADDRESS_LENGTH)
  .regex(ADDRESS_PATTERN)
  .refine((value) => !UNSTORABLE_HEADER_CHARACTER.test(value));
const recipient = z.object({ address, name: headerText(MAX_NAME_LENGTH).default("") }).strict();
const recipients = z.array(recipient).max(MAX_RECIPIENTS);
const subject = headerText(MAX_SUBJECT_LENGTH);
const body = z.string().max(MAX_BODY_LENGTH).refine(isStorableBody);

const createBodySchema = z
  .object({
    mailboxId: z.uuid(),
    from: address,
    to: recipients,
    cc: recipients,
    bcc: recipients,
    subject,
    body,
    threadId: z.uuid().nullable().default(null),
    mode: z.enum(MAIL_DRAFT_MODES).default("new"),
    sourceEmailId: z.uuid().nullable().default(null),
  })
  .strict();

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
 */
export function createMailDraftCreateRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<EmailDraftView> => {
    const parsed = createBodySchema.safeParse(ctx.body);
    if (!parsed.success) throw invalidBody(parsed.error);
    const { mailboxId, sourceEmailId, ...fields } = parsed.data;
    const draft = await withTransaction(pool, (client) =>
      createEmailDraftInMailbox(
        client,
        { ...fields, mailboxItemId: mailboxId, sourceEmailItemId: sourceEmailId },
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

/** `DELETE /api/mail/drafts/:id` (issue gh-1867): discards the draft (`discardEmailDraft`) and answers 200 with its id. */
export function createMailDraftDiscardRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: DraftRouteContext): DraftRouteResult<{ id: string }> => {
    const draftId = draftIdOf(ctx);
    await withTransaction(pool, (client) => discardEmailDraft(client, draftId, writeContext(ctx, queueAffinity)));
    return { status: 200, body: { id: draftId } };
  };
}
