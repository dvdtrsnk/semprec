import {
  prepareGmailMove,
  registerGmailMovePreparer,
  gmailMoveRequest,
  type GmailMoveResult,
} from "./mailMoveProviderAdapters.js";
import { privateSendOperation, readSendBody } from "./mailSendPrivacy.js";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import type {
  GmailFetchedMessage,
  GmailHistoryResult,
  GmailLabelRef,
  GmailMailClient,
  GmailMessageFormat,
  GmailMessageIdPage,
} from "./gmailReconcile.js";
import {
  assertJsonObject,
  MAX_ATTACHMENT_BYTES,
  MailReauthorizationRequiredError,
  MailRecipientRejectedError,
  type FetchedMessage,
} from "./providerTypes.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { isDeliveryStatusReport, parseContentTypeHeader } from "./dsn.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Ids one listing page holds, and so one write transaction of a sync pass ingests. */
const GMAIL_LISTING_PAGE_SIZE = 50;

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface GmailPayloadHeader {
  name: string;
  value: string;
}

interface GmailPayloadPart {
  partId?: string;
  /** Absent on the payload of a `format=metadata` response. */
  mimeType?: string;
  filename?: string;
  headers?: GmailPayloadHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayloadPart[];
}

function partHeader(part: GmailPayloadPart, name: string): string | undefined {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Every occurrence of a header, in order; Delivered-To resolution needs repeats. */
function partHeaderValues(part: GmailPayloadPart, name: string): string[] {
  return (part.headers ?? []).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);
}

/**
 * Rebuilds a header-only raw block and runs mailparser on it for address-list/Message-ID
 * parsing, so cost is bounded by header size, never by attachment bytes.
 */
async function parseGmailHeaders(headers: GmailPayloadHeader[]) {
  const raw = headers.map((h) => `${h.name}: ${h.value.replace(/\r?\n/g, " ")}`).join("\r\n") + "\r\n\r\n";
  return simpleParser(raw, { skipHtmlToText: true });
}

interface GmailMimeTree {
  textPlainPart?: GmailPayloadPart;
  textHtmlPart?: GmailPayloadPart;
  attachmentParts: GmailPayloadPart[];
}

/** The first unnamed text/plain and text/html leaves are the body; every other leaf is a candidate attachment. */
function walkGmailPayload(root: GmailPayloadPart): GmailMimeTree {
  const tree: GmailMimeTree = { attachmentParts: [] };
  const visit = (node: GmailPayloadPart): void => {
    if (node.parts && node.parts.length > 0) {
      for (const child of node.parts) visit(child);
      return;
    }
    const type = (node.mimeType ?? "").toLowerCase();
    if (!tree.textPlainPart && type === "text/plain" && !node.filename) {
      tree.textPlainPart = node;
      return;
    }
    if (!tree.textHtmlPart && type === "text/html" && !node.filename) {
      tree.textHtmlPart = node;
      return;
    }
    tree.attachmentParts.push(node);
  };
  visit(root);
  return tree;
}

function decodePartText(part: GmailPayloadPart | undefined): string | undefined {
  return part?.body?.data ? decodeBase64Url(part.body.data).toString("utf8") : undefined;
}

/**
 * Gmail can represent a Drive/Docs "attachment" as a tiny part holding only its share URL;
 * ingesting it would store the URL bytes as a file. Query/hash are ignored because the body may
 * render the same share with a different `usp` value.
 */
function normalizedGoogleShareUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com"))
    return null;

  const path = url.pathname.replace(/\/+$/, "");
  if (!path) return null;
  // `open`/`uc` carry the share identity in the `id` query parameter.
  if (path === "/open" || path === "/uc") {
    const id = url.searchParams.get("id");
    if (!id) return null;
    return `${url.hostname}${path}?id=${id}`;
  }
  return `${url.hostname}${path}`;
}

function normalizedGoogleShareUrls(text: string | undefined): Set<string> {
  const urls = new Set<string>();
  if (!text) return urls;
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    // Strip trailing prose punctuation so plain-text URLs match those parsed from an href.
    const trimmed = match[0].replace(/[.,;:!?)\]}>]+$/, "");
    const normalized = normalizedGoogleShareUrl(trimmed);
    if (normalized) urls.add(normalized);
  }
  return urls;
}

/** A replacement part reports only a small placeholder size even though its decoded URL text is much larger. */
function isGmailDriveReplacement(part: GmailPayloadPart, renderedDriveUrls: Set<string>): boolean {
  const reportedSize = part.body?.size;
  const decodedText = decodePartText(part);
  if (reportedSize === undefined || !decodedText || reportedSize * 2 >= Buffer.byteLength(decodedText)) return false;

  for (const placeholderUrl of normalizedGoogleShareUrls(decodedText)) {
    if (renderedDriveUrls.has(placeholderUrl)) return true;
  }
  return false;
}

/**
 * Builds each candidate attachment's lazy byte source. Gmail has no streamed attachment
 * download, so each part is fetched whole as base64, but only when `openStream()` is called,
 * one part at a time; parts already inlined in the `format=full` response need no request.
 */
function classifyGmailAttachmentParts(
  fetchAttachmentBytes: (attachmentId: string) => Promise<Buffer>,
  parts: GmailPayloadPart[],
  html: string | undefined,
  text: string | undefined,
): ClassifiedAttachment[] {
  const renderedDriveUrls = new Set([...normalizedGoogleShareUrls(html), ...normalizedGoogleShareUrls(text)]);
  const candidates = parts.flatMap((part): ClassifiedAttachment[] => {
    if (isGmailDriveReplacement(part, renderedDriveUrls)) return [];

    const dispositionHeader = partHeader(part, "Content-Disposition");
    const disposition: "attachment" | "inline" = dispositionHeader?.toLowerCase().trim().startsWith("inline")
      ? "inline"
      : "attachment";
    const contentIdHeader = partHeader(part, "Content-ID");
    const contentId = contentIdHeader ? contentIdHeader.replace(/^<|>$/g, "") : null;
    return [
      {
        filename: part.filename || "attachment",
        contentType: part.mimeType || "application/octet-stream",
        contentId,
        disposition,
        openStream: async () => {
          if (part.body?.data) {
            if ((part.body.size ?? 0) > MAX_ATTACHMENT_BYTES) {
              throw new Error(
                `Gmail inline attachment part is ${part.body.size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte cap`,
              );
            }
            return Readable.from(decodeBase64Url(part.body.data));
          }
          if (!part.body?.attachmentId)
            throw new Error("Gmail attachment part has neither inline data nor an attachmentId");
          return Readable.from(await fetchAttachmentBytes(part.body.attachmentId));
        },
      },
    ];
  });
  // An inline part referenced via cid: in the HTML is a rendering asset, not a document.
  return candidates.filter(
    (a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))),
  );
}

/**
 * The headers a `format=metadata` fetch asks for: every header the envelope, threading, delivery resolution, bulk
 * detection and DSN detection read.
 */
const GMAIL_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "Delivered-To",
  "X-Original-To",
  "Envelope-To",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "Content-Type",
];

const SNIPPET_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Gmail's `snippet` is plain text with HTML entities escaped. */
function decodeGmailSnippet(snippet: string): string {
  return snippet.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity: string, name: string) => {
    const code =
      name.startsWith("#x") || name.startsWith("#X")
        ? Number.parseInt(name.slice(2), 16)
        : name.startsWith("#")
          ? Number.parseInt(name.slice(1), 10)
          : undefined;
    if (code === undefined) return SNIPPET_ENTITIES[name.toLowerCase()] ?? entity;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** `attachments` empty and no body parts: a `format=metadata` payload lists no parts. */
async function toFetchedMessage(
  gmailMessageId: string,
  payload: GmailPayloadPart,
  fetchAttachmentBytes: ((attachmentId: string) => Promise<Buffer>) | null,
): Promise<FetchedMessage> {
  const parsedHeaders = await parseGmailHeaders(payload.headers ?? []);
  const tree: GmailMimeTree = fetchAttachmentBytes ? walkGmailPayload(payload) : { attachmentParts: [] };
  const bodyText = decodePartText(tree.textPlainPart);
  const bodyHtml = decodePartText(tree.textHtmlPart);
  const contentType = parseContentTypeHeader(partHeader(payload, "Content-Type"));

  const references = Array.isArray(parsedHeaders.references)
    ? parsedHeaders.references
    : parsedHeaders.references
      ? [parsedHeaders.references]
      : [];
  const toList = (value: typeof parsedHeaders.to): MailEnvelopeAddress[] => {
    const objects = Array.isArray(value) ? value : value ? [value] : [];
    return objects
      .flatMap((o) => o.value)
      .filter((a): a is { name: string; address: string } => Boolean(a.address))
      .map((a) => ({ name: a.name || undefined, address: a.address }));
  };

  const replyTo = toList(parsedHeaders.replyTo);

  return {
    // Unique fallback so messages lacking Message-ID are not merged by dedup-by-messageId.
    messageId: parsedHeaders.messageId ?? `<${gmailMessageId}@gmail-api>`,
    inReplyTo: parsedHeaders.inReplyTo ?? null,
    references,
    subject: parsedHeaders.subject,
    envelope: {
      from: parsedHeaders.from?.value[0]?.address
        ? { name: parsedHeaders.from.value[0].name || undefined, address: parsedHeaders.from.value[0].address }
        : undefined,
      to: toList(parsedHeaders.to),
      cc: toList(parsedHeaders.cc),
      bcc: toList(parsedHeaders.bcc),
      ...(replyTo.length > 0 ? { replyTo } : {}),
    },
    bodyText,
    bodyHtml,
    date: parsedHeaders.date,
    attachments: fetchAttachmentBytes
      ? classifyGmailAttachmentParts(fetchAttachmentBytes, tree.attachmentParts, bodyHtml, bodyText)
      : [],
    deliveredToHeaders: partHeaderValues(payload, "Delivered-To"),
    xOriginalTo: partHeaderValues(payload, "X-Original-To")[0] ?? null,
    envelopeTo: partHeaderValues(payload, "Envelope-To")[0] ?? null,
    bulkHeaders: {
      listUnsubscribe: partHeader(payload, "List-Unsubscribe") ?? null,
      listId: partHeader(payload, "List-Id") ?? null,
      precedence: partHeader(payload, "Precedence") ?? null,
      autoSubmitted: partHeader(payload, "Auto-Submitted") ?? null,
    },
    isDsn: isDeliveryStatusReport(contentType?.type, contentType?.params),
  };
}

/** A failed send's body is read only to detect an invalid-recipient refusal. */
const SEND_ERROR_BODY_READ_LIMIT = 4_096;

/** Inferred wording (not confirmed against a live refusal); other wording is an ordinary failure. */
const RECIPIENT_REFUSAL = /invalid (to|cc|bcc) header|invalid recipient|recipient address rejected/i;

export interface GmailSentMessage {
  id: string;
  threadId: string;
}

/** A read failure propagates, so the send fails as an ordinary error, not a misclassified one. */
async function readSendErrorBodyStart(response: Response): Promise<string> {
  return (await readSendBody(response, SEND_ERROR_BODY_READ_LIMIT)).text;
}

/** Invalid recipient wins over status; 400/401 means reauthorization. Messages never include body or token. */
async function sendFailure(response: Response): Promise<Error> {
  const errorBodyStart = await readSendErrorBodyStart(response);
  if (RECIPIENT_REFUSAL.test(errorBodyStart)) return new MailRecipientRejectedError();
  if (response.status === 400 || response.status === 401) {
    return new MailReauthorizationRequiredError(`Gmail rejected the send with status ${response.status}`);
  }
  return new Error(`Gmail send failed with status ${response.status}`);
}

/** `GmailMailClient` over the Gmail REST API. Tokens come from `getAccessToken`, so no refresh token is held here. */
export class GmailRestClient implements GmailMailClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    registerGmailMovePreparer(this, (id, step) => this.prepareMoveStep(id, step));
  }

  async observeMoveMessage(messageId: string): Promise<GmailMoveResult> {
    const token = await this.getAccessToken();
    return gmailMoveRequest(this.fetchImpl, token, messageId);
  }

  async applyMoveStep(
    messageId: string,
    step: "trash" | "untrash" | "add_inbox" | "remove_inbox",
  ): Promise<GmailMoveResult> {
    return (await prepareGmailMove(this, messageId, step))();
  }

  private async prepareMoveStep(
    messageId: string,
    step: "trash" | "untrash" | "add_inbox" | "remove_inbox",
  ): Promise<() => Promise<GmailMoveResult>> {
    if (!messageId || messageId.length > 1024) throw new Error("Invalid Gmail message identity");
    if (!["trash", "untrash", "add_inbox", "remove_inbox"].includes(step)) throw new Error("Invalid Gmail move step");
    const token = await this.getAccessToken();
    let used = false;
    return () => {
      if (used) throw new Error("Gmail move command already used");
      used = true;
      return gmailMoveRequest(this.fetchImpl, token, messageId, step);
    };
  }

  private async request<T>(path: string): Promise<{ status: number; json: T | null }> {
    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // This boundary cannot expose a provider rejection that may contain bearer credentials.
      void error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Gmail sync provider request failed unexpectedly");
    }
    if (response.status === 404) return { status: 404, json: null };
    if (!response.ok) throw new Error(`Gmail API request failed with status ${response.status}`);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      void error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Gmail sync provider response could not be read");
    }
    const body = assertJsonObject(parsed, "Gmail API response");
    return { status: response.status, json: body as T };
  }

  async getCurrentHistoryId(): Promise<string> {
    const { status, json } = await this.request<{ historyId: string }>("/profile");
    if (!json)
      throw new Error(`Gmail /profile returned status ${status} with no body — account may be deleted or suspended`);
    return json.historyId;
  }

  async listHistorySince(startHistoryId: string): Promise<GmailHistoryResult> {
    const changedIds = new Set<string>();
    const removedIds = new Set<string>();
    let newHistoryId = startHistoryId;
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams({ startHistoryId, ...(pageToken ? { pageToken } : {}) });
      const { status, json } = await this.request<{
        history?: Array<{
          messagesAdded?: { message: { id: string } }[];
          messagesDeleted?: { message: { id: string } }[];
          labelsAdded?: { message: { id: string } }[];
          labelsRemoved?: { message: { id: string } }[];
        }>;
        historyId?: string;
        nextPageToken?: string;
      }>(`/history?${query.toString()}`);

      if (status === 404)
        return { invalidated: true, newHistoryId: startHistoryId, changedMessageIds: [], removedMessageIds: [] };

      for (const entry of json?.history ?? []) {
        for (const m of entry.messagesAdded ?? []) changedIds.add(m.message.id);
        for (const m of entry.labelsAdded ?? []) changedIds.add(m.message.id);
        for (const m of entry.labelsRemoved ?? []) changedIds.add(m.message.id);
        for (const m of entry.messagesDeleted ?? []) removedIds.add(m.message.id);
      }
      if (json?.historyId) newHistoryId = json.historyId;
      pageToken = json?.nextPageToken;
    } while (pageToken);

    return { invalidated: false, newHistoryId, changedMessageIds: [...changedIds], removedMessageIds: [...removedIds] };
  }

  async listMessageIds(query: string, pageToken: string | null): Promise<GmailMessageIdPage> {
    const params = new URLSearchParams({
      maxResults: String(GMAIL_LISTING_PAGE_SIZE),
      q: query,
      ...(pageToken ? { pageToken } : {}),
    });
    const { json } = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?${params.toString()}`,
    );
    return { ids: (json?.messages ?? []).map((m) => m.id), nextPageToken: json?.nextPageToken ?? null };
  }

  private async fetchAttachmentBytes(gmailMessageId: string, attachmentId: string): Promise<Buffer> {
    const { json } = await this.request<{ size: number; data: string }>(
      `/messages/${gmailMessageId}/attachments/${attachmentId}`,
    );
    if (!json) throw new Error("Gmail attachment not found");
    // Checked before decoding so an oversized (malformed) response is never materialized.
    if (json.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Gmail attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte cap`);
    }
    return decodeBase64Url(json.data);
  }

  async fetchMessage(id: string, format: GmailMessageFormat): Promise<GmailFetchedMessage | null> {
    // `format=full` avoids pulling every attachment's bytes into one response; `format=metadata` returns the named
    // headers, the labels and the snippet only.
    const query =
      format === "full"
        ? new URLSearchParams({ format: "full" })
        : new URLSearchParams([
            ["format", "metadata"],
            ...GMAIL_METADATA_HEADERS.map((name): [string, string] => ["metadataHeaders", name]),
          ]);
    const { status, json } = await this.request<{
      id: string;
      threadId: string;
      labelIds?: string[];
      snippet?: string;
      payload: GmailPayloadPart;
    }>(`/messages/${id}?${query.toString()}`);
    if (status === 404 || !json) return null;
    const message = await toFetchedMessage(
      json.id,
      json.payload,
      format === "full" ? (attachmentId) => this.fetchAttachmentBytes(json.id, attachmentId) : null,
    );
    const labelIds = json.labelIds ?? [];
    return {
      id: json.id,
      threadId: json.threadId,
      labelIds,
      ...(json.snippet !== undefined ? { snippet: decodeGmailSnippet(json.snippet) } : {}),
      message: {
        ...message,
        flags: [
          ...(!labelIds.includes("UNREAD") ? ["\\Seen"] : []),
          ...(labelIds.includes("STARRED") ? ["\\Flagged"] : []),
        ],
      },
    };
  }

  async listLabels(): Promise<GmailLabelRef[]> {
    const { json } = await this.request<unknown>("/labels");
    const body = assertJsonObject(json, "Gmail labels response");
    if (!Array.isArray(body.labels)) throw new Error("Gmail labels response has no label inventory");
    const seen = new Set<string>();
    return body.labels.map((value: unknown) => {
      const label = assertJsonObject(value, "Gmail label");
      if (
        typeof label.id !== "string" ||
        !label.id ||
        typeof label.name !== "string" ||
        (label.type !== "user" && label.type !== "system") ||
        seen.has(label.id)
      ) {
        throw new Error("Gmail labels response contains an invalid or duplicate label");
      }
      seen.add(label.id);
      return { id: label.id, name: label.name, type: label.type };
    });
  }

  async modifyMessageLabels(messageId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${BASE_URL}/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Gmail label modification failed with status ${response.status}`);
    await response.body?.cancel();
  }

  /** Gmail does not thread by In-Reply-To alone, so a reply must pass `threadId`. */
  async sendMessage(raw: Buffer, threadId?: string): Promise<GmailSentMessage> {
    const token = await this.getAccessToken();
    const response = await privateSendOperation(() =>
      this.fetchImpl(`${BASE_URL}/messages/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: raw.toString("base64url"), ...(threadId ? { threadId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    if (!response.ok) throw await privateSendOperation(() => sendFailure(response));
    const read = await privateSendOperation(() => readSendBody(response, 32 * 1024));
    if (read.truncated) throw new Error("Gmail send response is too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      throw new Error("Gmail send response is not valid JSON");
    }
    const body = assertJsonObject(parsed, "Gmail send response");
    if (typeof body.id !== "string" || typeof body.threadId !== "string") {
      throw new Error("Gmail send response is missing the message id or the thread id");
    }
    return { id: body.id, threadId: body.threadId };
  }
}
