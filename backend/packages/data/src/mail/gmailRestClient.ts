import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import type { GmailFetchedMessage, GmailHistoryResult, GmailLabelRef, GmailMailClient } from "./gmailReconcile.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface GmailPayloadHeader {
  name: string;
  value: string;
}

interface GmailPayloadPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailPayloadHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayloadPart[];
}

function partHeader(part: GmailPayloadPart, name: string): string | undefined {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Only the headers this issue's threading/envelope model needs, reconstructed as a tiny raw
 * header block (`Name: value\r\n...\r\n\r\n`, empty body) and run through mailparser purely for
 * its mature address-list/Message-ID parsing — bounded strictly by header size (a few KB),
 * never by the message's attachment bytes, unlike a whole-message `simpleParser` pass would be.
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

/** Same structural walk as imapFlowClient.ts's walkBodyStructure, over Gmail's `payload.parts` tree instead of IMAP BODYSTRUCTURE — a body leaf is a text/plain or text/html part with no filename of its own; everything else is a candidate attachment. */
function walkGmailPayload(root: GmailPayloadPart): GmailMimeTree {
  const tree: GmailMimeTree = { attachmentParts: [] };
  const visit = (node: GmailPayloadPart): void => {
    if (node.parts && node.parts.length > 0) {
      for (const child of node.parts) visit(child);
      return;
    }
    const type = node.mimeType.toLowerCase();
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
 * Builds each candidate attachment's lazy byte source. Gmail's REST API has no true streamed
 * download (unlike imapflow's `download()`/Graph's `$value`) — its only per-attachment
 * primitive is a single JSON response containing the whole part as base64. What this still
 * avoids, versus the old `format=raw` whole-message fetch, is buffering *every* attachment of
 * a message at once: each part's bytes are only fetched, one at a time, when `ingestAttachments`
 * (mail/attachments.ts) actually calls `openStream()` for that specific part — small parts
 * Gmail already inlined into `format=full`'s response need no extra request at all.
 */
function classifyGmailAttachmentParts(
  fetchAttachmentBytes: (attachmentId: string) => Promise<Buffer>,
  parts: GmailPayloadPart[],
  html: string | undefined,
): ClassifiedAttachment[] {
  const candidates = parts.map((part): ClassifiedAttachment => {
    const dispositionHeader = partHeader(part, "Content-Disposition");
    const disposition: "attachment" | "inline" = dispositionHeader?.toLowerCase().trim().startsWith("inline") ? "inline" : "attachment";
    const contentIdHeader = partHeader(part, "Content-ID");
    const contentId = contentIdHeader ? contentIdHeader.replace(/^<|>$/g, "") : null;
    return {
      filename: part.filename || "attachment",
      contentType: part.mimeType,
      contentId,
      disposition,
      openStream: async () => {
        if (part.body?.data) return Readable.from(decodeBase64Url(part.body.data));
        if (!part.body?.attachmentId) throw new Error("Gmail attachment part has neither inline data nor an attachmentId");
        return Readable.from(await fetchAttachmentBytes(part.body.attachmentId));
      },
    };
  });
  // Same "inline part actually referenced via cid: in the HTML body is a rendering asset, not
  // a document" rule the other two adapters apply (attachments.ts / imapFlowClient.ts).
  return candidates.filter((a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))));
}

async function toFetchedMessage(
  gmailMessageId: string,
  payload: GmailPayloadPart,
  fetchAttachmentBytes: (attachmentId: string) => Promise<Buffer>,
): Promise<FetchedMessage> {
  const parsedHeaders = await parseGmailHeaders(payload.headers ?? []);
  const tree = walkGmailPayload(payload);
  const bodyHtml = decodePartText(tree.textHtmlPart);

  const references = Array.isArray(parsedHeaders.references)
    ? parsedHeaders.references
    : parsedHeaders.references
      ? [parsedHeaders.references]
      : [];
  const toList = (value: typeof parsedHeaders.to): MailEnvelopeAddress[] => {
    const objects = Array.isArray(value) ? value : value ? [value] : [];
    return objects.flatMap((o) => o.value).filter((a): a is { name: string; address: string } => Boolean(a.address)).map((a) => ({ name: a.name || undefined, address: a.address }));
  };

  return {
    // Falls back to Gmail's own (always-unique) message id, not a fixed placeholder — two
    // different messages both missing a Message-ID header must not collide and get merged
    // into one Emails item by ingestEmailMessage's dedup-by-messageId.
    messageId: parsedHeaders.messageId ?? `<${gmailMessageId}@gmail-api>`,
    inReplyTo: parsedHeaders.inReplyTo ?? null,
    references,
    subject: parsedHeaders.subject,
    envelope: {
      from: parsedHeaders.from?.value[0]?.address ? { name: parsedHeaders.from.value[0].name || undefined, address: parsedHeaders.from.value[0].address } : undefined,
      to: toList(parsedHeaders.to),
      cc: toList(parsedHeaders.cc),
      bcc: toList(parsedHeaders.bcc),
    },
    bodyText: decodePartText(tree.textPlainPart),
    bodyHtml,
    date: parsedHeaders.date,
    attachments: classifyGmailAttachmentParts(fetchAttachmentBytes, tree.attachmentParts, bodyHtml),
  };
}

/**
 * Real `GmailMailClient` (gmailReconcile.ts) over the Gmail REST API — not exercised by this
 * issue's tests (no live Google account in CI); the reconcile logic itself is tested against
 * a fake client. `getAccessToken` is injected (see oauthTokenExchange.ts) rather than baked
 * in, so this class never itself holds a refresh token in memory beyond one call.
 */
export class GmailRestClient implements GmailMailClient {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  private async request<T>(path: string): Promise<{ status: number; json: T | null }> {
    const token = await this.getAccessToken();
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return { status: 404, json: null };
    if (!response.ok) throw new Error(`Gmail API request to ${path} failed with status ${response.status}`);
    return { status: response.status, json: (await response.json()) as T };
  }

  async getCurrentHistoryId(): Promise<string> {
    const { json } = await this.request<{ historyId: string }>("/profile");
    return json!.historyId;
  }

  async listHistorySince(startHistoryId: string): Promise<GmailHistoryResult> {
    const changedIds = new Set<string>();
    const removedIds = new Set<string>();
    let newHistoryId = startHistoryId;
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams({ startHistoryId, ...(pageToken ? { pageToken } : {}) });
      const { status, json } = await this.request<{
        history?: Array<{ messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsAdded?: { message: { id: string } }[]; labelsRemoved?: { message: { id: string } }[] }>;
        historyId?: string;
        nextPageToken?: string;
      }>(`/history?${query.toString()}`);

      if (status === 404) return { invalidated: true, newHistoryId: startHistoryId, changedMessageIds: [], removedMessageIds: [] };

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

  async listAllMessageIds(): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: "500", ...(pageToken ? { pageToken } : {}) });
      const { json } = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${query.toString()}`);
      for (const m of json?.messages ?? []) ids.push(m.id);
      pageToken = json?.nextPageToken;
    } while (pageToken);
    return ids;
  }

  private async fetchAttachmentBytes(gmailMessageId: string, attachmentId: string): Promise<Buffer> {
    const { json } = await this.request<{ size: number; data: string }>(`/messages/${gmailMessageId}/attachments/${attachmentId}`);
    if (!json) throw new Error(`Gmail attachment ${attachmentId} on message ${gmailMessageId} not found`);
    return decodeBase64Url(json.data);
  }

  async fetchMessage(id: string): Promise<GmailFetchedMessage | null> {
    // `format=full` (not `format=raw`): structure + headers + small-part bodies, without ever
    // pulling every attachment's bytes into one response — see toFetchedMessage's header note.
    const { status, json } = await this.request<{ id: string; threadId: string; labelIds?: string[]; payload: GmailPayloadPart }>(`/messages/${id}?format=full`);
    if (status === 404 || !json) return null;
    const message = await toFetchedMessage(json.id, json.payload, (attachmentId) => this.fetchAttachmentBytes(json.id, attachmentId));
    return { id: json.id, threadId: json.threadId, labelIds: json.labelIds ?? [], message };
  }

  async listLabels(): Promise<GmailLabelRef[]> {
    const { json } = await this.request<{ labels?: { id: string; name: string; type: string }[] }>("/labels");
    return (json?.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type === "system" ? "system" : "user" }));
  }
}
