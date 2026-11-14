// Starts a reply, reply-all or forward draft from a received message (issue gh-1899): computes the recipients, the
// sending address, the subject, the threading headers and the quoted text from the source message, creates the draft
// through `createEmailDraftInMailbox` and, for a forward, copies the source's attachments through
// `attachFileToDraft`. The create route (`mailDraftRouteHandlers.ts`) calls `createPrefilledEmailDraft` for the
// three modes; the draft itself, its row and its edges are written by `draft.ts`, not here.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-11-14-a-mail-draft-attaches-copies-of-held-files-and-trashes-the-files-that-are-its-own.md
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
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

/** The modes that start from a received message; `new` starts from nothing and is written as the caller gave it. */
export type PrefilledDraftMode = Exclude<MailDraftMode, "new">;

export function isPrefilledDraftMode(mode: MailDraftMode): mode is PrefilledDraftMode {
  return mode !== "new";
}

/**
 * The most of the source's text a draft quotes. A received message can be far larger than the 500000 characters the
 * draft routes accept as a body, and a reply of that size could not be edited again.
 */
const MAX_QUOTED_TEXT_LENGTH = 100_000;

/** Every character of this class is replaced in a value that reaches a header or the draft row. */
const UNSTORABLE_HEADER_CHARACTERS = new RegExp(UNSTORABLE_HEADER_CHARACTER.source, "gu");

/** What the draft takes from its source message, before the caller's own text is added. */
interface DraftPrefill {
  /** The registered address of the mailbox that the draft is sent from. */
  from: string;
  to: MailDraftRecipient[];
  /** Always empty: the compose window has no Cc field, so reply-all puts every recipient into `to`. */
  cc: MailDraftRecipient[];
  /** Always empty. */
  bcc: MailDraftRecipient[];
  subject: string;
  /** The header line and the quoted source text; the draft body is the caller's text, an empty line and this. */
  quote: string;
  /** The source's thread, which a forward keeps as the thread it started from. */
  threadId: string | null;
  /** The source's Message-ID for a reply, `null` for a forward. */
  inReplyTo: string | null;
  references: string[];
  /** The Files items the source message holds, which a forward copies. Empty for a reply. */
  attachmentFileItemIds: string[];
}

interface DraftPrefillInput {
  mailboxItemId: string;
  sourceEmailItemId: string;
  mode: PrefilledDraftMode;
  /** `users.locale` of the person the draft is made for; the quote's header lines are in this language. */
  locale: string;
}

/** Replaces the control characters of a value that reaches a header and cuts it to `max` UTF-16 units without splitting a pair. */
function headerText(value: string, max: number): string {
  const cleaned = value.replace(UNSTORABLE_HEADER_CHARACTERS, " ").trim();
  if (cleaned.length <= max) return cleaned;
  const lastKept = cleaned.charCodeAt(max - 1);
  return cleaned.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? max - 1 : max);
}

/** The recipients of an envelope list that can be sent to: an address of the draft routes' shape, with a header-safe name. */
function usableRecipients(list: readonly MailEnvelopeAddress[] | undefined): MailDraftRecipient[] {
  const recipients: MailDraftRecipient[] = [];
  for (const entry of list ?? []) {
    const address = entry.address.trim();
    if (!ADDRESS_PATTERN.test(address) || UNSTORABLE_HEADER_CHARACTER.test(address)) continue;
    recipients.push({ name: headerText(entry.name ?? "", MAX_NAME_LENGTH), address });
  }
  return recipients;
}

/** The recipients without the addresses of `exclude` (normalized) and without a second entry for one address. */
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
 * The address the draft is sent from: the address the source was delivered to when it is one of the mailbox's
 * addresses (in the form the mailbox lists it), otherwise the mailbox's first address, its primary one.
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

/** The entities `htmlToPlainText` leaves escaped in its output, decoded in one pass so `&amp;lt;` becomes `&lt;`. */
const PLAIN_TEXT_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * The markup that tells a stored body is HTML: a doctype or a comment, or the start or end tag of an HTML element that
 * mail uses, right behind the element's name a space, a slash or the end of the tag. `<petr@example.test>`,
 * `<https://example.test/a>` and `1 < 2 > 0` of a text part are no markup: after a name they have `@` or `:`.
 */
const HTML_MARKUP =
  /<(?:!doctype\s+html|!--|\/?(?:html|head|body|title|meta|link|style|script|div|p|br|hr|span|a|b|i|u|s|em|strong|small|big|font|center|pre|code|blockquote|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|img|h[1-6]|section|article|header|footer|nav|main|abbr|sub|sup)(?=[\s/>]))/i;

/**
 * The text of a stored body for quoting. Emails stores one `body`, the HTML part else the text part (`ingest.ts`), and
 * nothing records which, so a body with HTML markup (`HTML_MARKUP`) goes through `htmlToPlainText` as in the thread
 * read (`mailThreadDetail.ts`), line breaks the markup meant being kept first, and any other body is the text part and
 * is quoted as it is: the person sends this text, so the addresses and links in angle brackets of a text mail
 * (`Petr <petr@example.test> wrote:`) and a literal `&amp;` must reach the quote unchanged.
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

/** The source's own date, else the time it entered Semprec, else the item's creation time. */
function sourceDate(item: ItemRow, ingestedAt: Date | null): Date {
  const stored = new Date(textProperty(item, "date"));
  if (!Number.isNaN(stored.getTime())) return stored;
  return ingestedAt ?? new Date(item.createdAt);
}

/** Returns the catalog text of a key in the person's locale, with `{name}` placeholders replaced in one pass. */
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
 * Computes what a reply, a reply-all or a forward of the received message `input.sourceEmailItemId` starts with, for
 * a draft of the mailbox `input.mailboxItemId`, in the caller's transaction and tenant. An unknown mailbox, an
 * unknown source (another tenant's included) and an Emails item that is no received message (it has no
 * `mail_message_meta` row, as a draft has none) are 404s; a mailbox without an address is a 400, and so is a tenant
 * time zone that Luxon cannot read. The quote's date is written by Luxon, as the settings writer validates the zone
 * with it: a fixed offset such as `UTC+2` is a zone a tenant can store, and `Intl.DateTimeFormat` throws for it.
 *
 * - `reply` goes to the source's Reply-To, otherwise to its sender; `replyAll` goes to those and the source's To and
 *   Cc recipients, without any address of the mailbox and without duplicates; `forward` has no recipients. Cc and Bcc
 *   are empty in every mode.
 * - The subject is the source's with `Re: ` or `Fwd: ` in front, unless it starts with that prefix in any letter case.
 * - A reply's `inReplyTo` is the source's Message-ID and its `references` are the source's followed by that
 *   Message-ID. A forward sets neither; it keeps the source's thread id only as the thread it started from.
 * - The quote is a header line in the person's locale and the source's plain text, every line behind `> `; a
 *   forward's header lists the original sender, date, subject and recipients.
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

/** Values a caller gives for fields the prefill computes; a field that is present replaces the computed one. */
export interface DraftPrefillOverrides {
  to?: MailDraftRecipient[];
  cc?: MailDraftRecipient[];
  bcc?: MailDraftRecipient[];
  /** Taken as it is, without the `Re: ` or `Fwd: ` prefix. */
  subject?: string;
}

/** `overrides` without its absent fields, so that spreading it over the prefill replaces only what was given. */
function definedOnly(overrides: DraftPrefillOverrides | undefined): DraftPrefillOverrides {
  return Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined));
}

export interface CreatePrefilledEmailDraftInput extends DraftPrefillInput {
  /** The person's own text; the draft body is this text, an empty line and the quote. */
  body: string;
  /**
   * What the caller addresses itself instead of taking it from the source: the recipients and the subject. The route
   * passes none (its client changes them with an update); `mail.draft.create` of an agent passes those its call gave.
   * The mailbox, the sending address, the threading and the quote always come from the source.
   */
  overrides?: DraftPrefillOverrides;
  /**
   * The limit for the attachments of a forward in a mailbox without a provider limit (`attachFileToDraft`). A
   * forward whose source holds attachments fails with a plain error when it is absent; no other mode reads it.
   */
  uploadLimitBytes?: number;
}

/**
 * Creates the draft that `computeDraftPrefill` describes in the caller's transaction and tenant
 * (`createEmailDraftInMailbox`; its refusals are this function's) and returns its view. A forward then gets its own
 * copy of each of the source's attachments from `attachFileToDraft`, so the source keeps its files; a forward that
 * would pass the mailbox's attachment limit is refused with the 413 of `attachFileToDraft` and nothing is written.
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
