// Starts a reply, reply-all or forward draft from a received message: computes recipients, sending address, subject,
// threading headers and quoted text, creates the draft through `createEmailDraftInMailbox` and, for a forward, copies
// the source's attachments through `attachFileToDraft`.
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@alldots/module-registry";
import { getItemById } from "../chokePoint/itemsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { toManifestLocale, type ManifestLocale } from "../manifest/catalogResolution.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import type { ItemRow } from "../types.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { createEmailDraftInMailbox, readEmailDraft, type EmailDraftView, type MailDraftWriteContext } from "./draft.js";
import { formatAddress } from "./ingest.js";
import {
  ADDRESS_PATTERN,
  MAX_NAME_LENGTH,
  MAX_SUBJECT_LENGTH,
  UNSTORABLE_HEADER_CHARACTER,
} from "./mailDraftFields.js";
import { listDraftAttachments } from "./mailDraftAttachmentFiles.js";
import { attachFileToDraft } from "./mailDraftAttachments.js";
import type { MailDraftMode, MailDraftRecipient } from "./mailDraftsStore.js";
import { getMailMessageMetaByItemId, type MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { htmlToPlainText } from "./mailPlainText.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";

export type PrefilledDraftMode = Exclude<MailDraftMode, "new">;

export function isPrefilledDraftMode(mode: MailDraftMode): mode is PrefilledDraftMode {
  return mode !== "new";
}

/** A received message can be far larger than a draft body may be, and a reply of that size could not be edited. */
const MAX_QUOTED_TEXT_LENGTH = 100_000;

const UNSTORABLE_HEADER_CHARACTERS = new RegExp(UNSTORABLE_HEADER_CHARACTER.source, "gu");

interface DraftPrefill {
  from: string;
  to: MailDraftRecipient[];
  /** Always empty: the compose window has no Cc field, so reply-all puts every recipient into `to`. */
  cc: MailDraftRecipient[];
  bcc: MailDraftRecipient[];
  subject: string;
  quote: string;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachmentFileItemIds: string[];
}

interface DraftPrefillInput {
  mailboxItemId: string;
  sourceEmailItemId: string;
  mode: PrefilledDraftMode;
  /** `users.locale`; the quote's header lines are in this language. */
  locale: string;
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function headerText(value: string, max: number): string {
  const cleaned = value.replace(UNSTORABLE_HEADER_CHARACTERS, " ").trim();
  if (cleaned.length <= max) return cleaned;
  const lastKept = cleaned.charCodeAt(max - 1);
  return cleaned.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? max - 1 : max);
}

function usableRecipients(list: readonly MailEnvelopeAddress[] | undefined): MailDraftRecipient[] {
  const recipients: MailDraftRecipient[] = [];
  for (const entry of list ?? []) {
    const address = entry.address.trim();
    if (!ADDRESS_PATTERN.test(address) || UNSTORABLE_HEADER_CHARACTER.test(address)) continue;
    recipients.push({ name: headerText(entry.name ?? "", MAX_NAME_LENGTH), address });
  }
  return recipients;
}

function withoutOwnAndDuplicates(
  list: readonly MailDraftRecipient[],
  exclude: ReadonlySet<string>,
): MailDraftRecipient[] {
  const seen = new Set(exclude);
  return list.filter((entry) => {
    const key = normalizeEmailAddress(entry.address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The address the source was delivered to when the mailbox lists it (in the mailbox's form), else the mailbox's
 * primary address.
 */
export function sendingAddress(registered: readonly string[], deliveredTo: string | null): string {
  const delivered = deliveredTo === null ? null : normalizeEmailAddress(deliveredTo);
  const match = registered.find((address) => normalizeEmailAddress(address) === delivered);
  const from = match ?? registered[0];
  if (from === undefined) throw new ValidationError("The mailbox has no address to send from", { field: "mailboxId" });
  return from;
}

function withPrefix(prefix: "Re:" | "Fwd:", subject: string): string {
  const cleaned = headerText(subject, MAX_SUBJECT_LENGTH);
  const has = cleaned.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
  return headerText(has ? cleaned : `${prefix} ${cleaned}`, MAX_SUBJECT_LENGTH);
}

/** Decoded in one pass so `&amp;lt;` becomes `&lt;`. */
const PLAIN_TEXT_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Markup that marks a stored body as HTML. `<petr@example.test>`, `<https://example.test/a>` and `1 < 2 > 0` in a text
 * part do not match: after a name they have `@` or `:`.
 */
const HTML_MARKUP =
  /<(?:!doctype\s+html|!--|\/?(?:html|head|body|title|meta|link|style|script|div|p|br|hr|span|a|b|i|u|s|em|strong|small|big|font|center|pre|code|blockquote|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|img|h[1-6]|section|article|header|footer|nav|main|abbr|sub|sup)(?=[\s/>]))/i;

/**
 * Emails stores one `body` (the HTML part, else the text part) without recording which, so a body with HTML markup is
 * converted like the thread read does, and any other body is quoted unchanged: angle-bracket addresses and a literal
 * `&amp;` of a text mail must reach the quote as they are.
 */
function plainTextOf(body: string): string {
  let text: string;
  if (HTML_MARKUP.test(body)) {
    const withBreaks = body
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(?:p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n");
    text = htmlToPlainText(withBreaks).replace(
      /&(?:amp|lt|gt|quot|#39|nbsp);/g,
      (entity) => PLAIN_TEXT_ENTITIES[entity] ?? entity,
    );
  } else {
    text = body;
  }
  text = text.replace(/\r\n?/g, "\n").trim();
  if (text.length <= MAX_QUOTED_TEXT_LENGTH) return text;
  const lastKept = text.charCodeAt(MAX_QUOTED_TEXT_LENGTH - 1);
  return text.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? MAX_QUOTED_TEXT_LENGTH - 1 : MAX_QUOTED_TEXT_LENGTH);
}

function textProperty(item: ItemRow, key: string): string {
  const value = item.properties[key];
  return typeof value === "string" ? value : "";
}

function sourceDate(item: ItemRow, ingestedAt: Date | null): Date {
  const stored = new Date(textProperty(item, "date"));
  if (!Number.isNaN(stored.getTime())) return stored;
  return ingestedAt ?? new Date(item.createdAt);
}

async function loadCatalogText(
  locale: ManifestLocale,
): Promise<(key: string, values?: Readonly<Record<string, string>>) => string> {
  const catalogs = await loadModuleCatalogs(import.meta.url);
  return (key, values = {}) =>
    resolveCatalogLabel(null, catalogs[locale], catalogs.en, key).replace(
      /\{(\w+)\}/g,
      (placeholder, name: string) => values[name] ?? placeholder,
    );
}

function quoteLines(text: string): string[] {
  return text === "" ? [] : text.split("\n").map((line) => `> ${line}`);
}

/**
 * Computes what a reply, reply-all or forward of a received message starts with. 404 for an unknown mailbox or
 * source or an Emails item with no `mail_message_meta` row (a draft); 400 for a mailbox without an address or a time
 * zone Luxon cannot read. Luxon formats the date because the settings writer validates zones with it, and
 * `Intl.DateTimeFormat` throws for a stored fixed offset such as `UTC+2`.
 *
 * - `reply` goes to Reply-To, else the sender; `replyAll` adds To and Cc minus the mailbox's own addresses and
 *   duplicates; `forward` has no recipients. Cc and Bcc are always empty.
 * - Subject gets `Re: ` / `Fwd: ` unless it already starts with it (any case).
 * - A reply sets `inReplyTo` and `references`; a forward sets neither and keeps the source's thread id.
 */
async function computeDraftPrefill(client: PoolClient, input: DraftPrefillInput): Promise<DraftPrefill> {
  const ids = await resolveMailModuleIds(client);
  const mailbox = await getItemById(client, ids.mailboxesDatabaseId, input.mailboxItemId);
  if (!mailbox || mailbox.deletedAt) throw new NotFoundError("Mailbox not found");
  const source = await getItemById(client, ids.emailsDatabaseId, input.sourceEmailItemId);
  const meta = source && !source.deletedAt ? await getMailMessageMetaByItemId(client, source.id) : null;
  if (!source || !meta) throw new NotFoundError("Source message not found");

  const registered = parseAddressListProperty(mailbox.properties.addresses);
  const own = new Set(registered.map(normalizeEmailAddress));
  const { envelope } = meta;
  const sender = usableRecipients(envelope.from ? [envelope.from] : []);
  const replyTo = usableRecipients(envelope.replyTo);
  const originalTo = usableRecipients(envelope.to);
  const originalCc = usableRecipients(envelope.cc);

  const subject = textProperty(source, "name");
  const isForward = input.mode === "forward";
  let to: MailDraftRecipient[] = [];
  if (input.mode === "reply") to = replyTo.length > 0 ? replyTo : sender;
  if (input.mode === "replyAll") {
    to = withoutOwnAndDuplicates([...(replyTo.length > 0 ? replyTo : sender), ...originalTo, ...originalCc], own);
  }

  const locale = toManifestLocale(input.locale);
  const timeZone = await getSystemTimezone(client);
  assertValidTimezone(timeZone);
  const date = DateTime.fromJSDate(sourceDate(source, meta.ingestedAt), { zone: timeZone })
    .setLocale(locale)
    .toLocaleString({ dateStyle: "long", timeStyle: "short" });
  const senderName = envelope.from?.name || envelope.from?.address || textProperty(source, "sender");
  const text = quoteLines(plainTextOf(textProperty(source, "body")));
  const label = await loadCatalogText(locale);
  const header = isForward
    ? [
        label("mail.draft.forwardHeader"),
        `${label("mail.draft.forward.from")}: ${headerText(
          envelope.from ? formatAddress(envelope.from) : textProperty(source, "sender"),
          MAX_NAME_LENGTH * 2,
        )}`,
        `${label("mail.draft.forward.date")}: ${date}`,
        `${label("mail.draft.forward.subject")}: ${headerText(subject, MAX_SUBJECT_LENGTH)}`,
        `${label("mail.draft.forward.to")}: ${originalTo.map(formatAddress).join(", ")}`,
        ...(originalCc.length > 0
          ? [`${label("mail.draft.forward.cc")}: ${originalCc.map(formatAddress).join(", ")}`]
          : []),
        ...(text.length > 0 ? [""] : []),
      ]
    : [label("mail.draft.replyHeader", { date, name: headerText(senderName, MAX_NAME_LENGTH) })];

  return {
    from: sendingAddress(registered, meta.deliveredToAddress),
    to,
    cc: [],
    bcc: [],
    subject: withPrefix(isForward ? "Fwd:" : "Re:", subject),
    quote: [...header, ...text].join("\n"),
    threadId: meta.threadId,
    inReplyTo: isForward ? null : meta.messageId,
    references: isForward
      ? []
      : meta.references.at(-1) === meta.messageId
        ? meta.references
        : [...meta.references, meta.messageId],
    attachmentFileItemIds: isForward
      ? (await listDraftAttachments(client, ids, source.id)).map((attachment) => attachment.fileItemId)
      : [],
  };
}

/** Fields that replace the computed prefill when present. */
export interface DraftPrefillOverrides {
  to?: MailDraftRecipient[];
  cc?: MailDraftRecipient[];
  bcc?: MailDraftRecipient[];
  /** Taken as it is, without the `Re: ` or `Fwd: ` prefix. */
  subject?: string;
}

function definedOnly(overrides: DraftPrefillOverrides | undefined): DraftPrefillOverrides {
  return Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined));
}

export interface CreatePrefilledEmailDraftInput extends DraftPrefillInput {
  body: string;
  /**
   * Recipients and subject the caller sets itself (agent `mail.draft.create`); the route passes none. Mailbox,
   * sending address, threading and quote always come from the source.
   */
  overrides?: DraftPrefillOverrides;
  /** Required only by a forward whose source has attachments (see `attachFileToDraft`). */
  uploadLimitBytes?: number;
}

/**
 * Creates the draft `computeDraftPrefill` describes and returns its view. A forward gets its own copy of each source
 * attachment; one over the mailbox's attachment limit fails with the 413 of `attachFileToDraft` and writes nothing.
 */
export async function createPrefilledEmailDraft(
  client: PoolClient,
  input: CreatePrefilledEmailDraftInput,
  context: MailDraftWriteContext,
): Promise<EmailDraftView> {
  const computed = await computeDraftPrefill(client, input);
  const prefill = { ...computed, ...definedOnly(input.overrides) };
  const created = await createEmailDraftInMailbox(
    client,
    {
      mailboxItemId: input.mailboxItemId,
      from: prefill.from,
      to: prefill.to,
      cc: prefill.cc,
      bcc: prefill.bcc,
      subject: prefill.subject,
      body: `${input.body}\n\n${prefill.quote}`,
      threadId: prefill.threadId,
      mode: input.mode,
      sourceEmailItemId: input.sourceEmailItemId,
      inReplyTo: prefill.inReplyTo,
      references: prefill.references,
    },
    context,
  );
  if (prefill.attachmentFileItemIds.length === 0) return created;
  const { uploadLimitBytes } = input;
  if (uploadLimitBytes === undefined) throw new Error("A forward with attachments needs the upload limit");
  for (const fileItemId of prefill.attachmentFileItemIds) {
    await attachFileToDraft(client, { draftItemId: created.id, fileItemId, uploadLimitBytes }, context);
  }
  return readEmailDraft(client, created.id);
}
