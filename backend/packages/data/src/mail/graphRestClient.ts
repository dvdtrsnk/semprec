import {
  prepareGraphMove,
  registerGraphMovePreparer,
  graphMoveRequest,
  type GraphMoveResult,
} from "./mailMoveProviderAdapters.js";
import { privateSendOperation, readSendBody, reportSendCleanupFailure } from "./mailSendPrivacy.js";
import { Readable, Transform } from "node:stream";
import type { ClassifiedAttachment } from "./attachments.js";
import type { GraphChangedMessage, GraphDeltaResult, GraphFolderRef, GraphMailClient } from "./graphReconcile.js";
import {
  assertJsonObject,
  MailReauthorizationRequiredError,
  MailRecipientRejectedError,
  MAX_ATTACHMENT_BYTES,
  type FetchedMessage,
} from "./providerTypes.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { isDeliveryStatusReport, parseContentTypeHeader } from "./dsn.js";

const BASE_URL = "https://graph.microsoft.com/v1.0/me";
const WELL_KNOWN_FOLDERS = ["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"];

interface GraphMessageResource {
  id: string;
  parentFolderId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress: { name?: string; address: string } };
  toRecipients?: { emailAddress: { name?: string; address: string } }[];
  ccRecipients?: { emailAddress: { name?: string; address: string } }[];
  bccRecipients?: { emailAddress: { name?: string; address: string } }[];
  replyTo?: { emailAddress: { name?: string; address: string } }[];
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  receivedDateTime?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  hasAttachments?: boolean;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  ["@removed"]?: { reason: string };
}

interface GraphAttachmentResource {
  ["@odata.type"]: unknown;
  id: string;
  name?: unknown;
  contentType?: string;
  isInline?: boolean;
  contentId?: string;
}

type GraphNonFileAttachmentType = "itemAttachment" | "referenceAttachment";

interface GraphNonFileAttachment {
  filename: string;
  providerType: GraphNonFileAttachmentType;
  id: string;
}

function toEnvelopeAddress(v?: { emailAddress: { name?: string; address: string } }): MailEnvelopeAddress | undefined {
  return v?.emailAddress?.address ? { name: v.emailAddress.name, address: v.emailAddress.address } : undefined;
}

function toEnvelopeAddressList(v?: { emailAddress: { name?: string; address: string } }[]): MailEnvelopeAddress[] {
  return (v ?? []).map(toEnvelopeAddress).filter((a): a is MailEnvelopeAddress => Boolean(a));
}

function header(resource: GraphMessageResource, name: string): string | undefined {
  return resource.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Every occurrence of a header, in order; Delivered-To resolution needs repeats. */
function headerValues(resource: GraphMessageResource, name: string): string[] {
  return (resource.internetMessageHeaders ?? [])
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value);
}

function safeAttachmentLabel(name: unknown): string {
  // Untrusted: strip control characters so the text form cannot forge extra annotations.
  const withoutControls = Array.from(typeof name === "string" ? name : "")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? " " : character;
    })
    .join("");
  const normalized = withoutControls.trim().replace(/\s+/g, " ");
  return normalized || "attachment";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function graphNonFileAttachmentType(odataType: unknown): GraphNonFileAttachmentType | undefined {
  switch (odataType) {
    case "#microsoft.graph.itemAttachment":
      return "itemAttachment";
    case "#microsoft.graph.referenceAttachment":
      return "referenceAttachment";
    default:
      return undefined;
  }
}

function compareGraphNonFileAttachments(a: GraphNonFileAttachment, b: GraphNonFileAttachment): number {
  if (a.providerType !== b.providerType) return a.providerType < b.providerType ? -1 : 1;
  if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function appendGraphNonFileAttachmentAnnotations(
  body: string | undefined,
  attachments: GraphNonFileAttachment[],
  format: "html" | "text",
): string | undefined {
  if (attachments.length === 0) return body;

  const annotations = [...attachments].sort(compareGraphNonFileAttachments).map((attachment) => {
    const text = `[${attachment.providerType}: ${attachment.filename}]`;
    return format === "html" ? `<p>${escapeHtml(text)}</p>` : text;
  });
  const separator = format === "html" ? "" : "\n\n";
  return [body, ...annotations].filter((part): part is string => Boolean(part)).join(separator);
}

/** Lazy byte sources over `/attachments/{id}/$value`, a true streamed response. */
function classifyGraphAttachments(
  fetchAttachmentStream: (attachmentId: string) => Promise<Readable>,
  metas: GraphAttachmentResource[],
  html: string | undefined,
): ClassifiedAttachment[] {
  const candidates = metas
    .filter((m) => m["@odata.type"] === "#microsoft.graph.fileAttachment")
    .map((m): ClassifiedAttachment => ({
      filename: safeAttachmentLabel(m.name),
      contentType: m.contentType || "application/octet-stream",
      contentId: m.contentId ?? null,
      disposition: m.isInline ? "inline" : "attachment",
      openStream: () => fetchAttachmentStream(m.id),
    }));
  // An inline part referenced via cid: in the HTML is a rendering asset, not a document.
  return candidates.filter(
    (a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))),
  );
}

/**
 * Item/reference attachments have no bytes, so they become body annotations rather than Files
 * rows; repeated delta passes then converge through message dedup like the body.
 */
export async function toFetchedGraphMessage(
  resource: GraphMessageResource,
  listAttachmentMetadata: (messageId: string) => Promise<GraphAttachmentResource[]>,
  fetchAttachmentStream: (messageId: string, attachmentId: string) => Promise<Readable>,
): Promise<FetchedMessage> {
  const referencesHeader = header(resource, "References");
  const html = resource.body?.contentType === "html" ? resource.body.content : undefined;
  const attachmentMetas = resource.hasAttachments ? await listAttachmentMetadata(resource.id) : [];
  const attachments = classifyGraphAttachments(
    (attachmentId) => fetchAttachmentStream(resource.id, attachmentId),
    attachmentMetas,
    html,
  );
  const nonFileAttachments = attachmentMetas.flatMap((attachment): GraphNonFileAttachment[] => {
    const providerType = graphNonFileAttachmentType(attachment["@odata.type"]);
    return providerType ? [{ filename: safeAttachmentLabel(attachment.name), providerType, id: attachment.id }] : [];
  });
  const contentType = parseContentTypeHeader(header(resource, "Content-Type"));

  const replyTo = toEnvelopeAddressList(resource.replyTo);

  return {
    messageId: resource.internetMessageId ?? `<no-message-id-${resource.id}@graph-api>`,
    inReplyTo: header(resource, "In-Reply-To") ?? null,
    references: referencesHeader ? referencesHeader.split(/\s+/).filter(Boolean) : [],
    subject: resource.subject,
    envelope: {
      from: toEnvelopeAddress(resource.from),
      to: toEnvelopeAddressList(resource.toRecipients),
      cc: toEnvelopeAddressList(resource.ccRecipients),
      bcc: toEnvelopeAddressList(resource.bccRecipients),
      ...(replyTo.length > 0 ? { replyTo } : {}),
    },
    bodyText: appendGraphNonFileAttachmentAnnotations(
      resource.body?.contentType === "text" ? resource.body.content : resource.bodyPreview,
      nonFileAttachments,
      "text",
    ),
    bodyHtml:
      html !== undefined ? appendGraphNonFileAttachmentAnnotations(html, nonFileAttachments, "html") : undefined,
    date: resource.receivedDateTime ? new Date(resource.receivedDateTime) : undefined,
    attachments,
    deliveredToHeaders: headerValues(resource, "Delivered-To"),
    xOriginalTo: headerValues(resource, "X-Original-To")[0] ?? null,
    envelopeTo: headerValues(resource, "Envelope-To")[0] ?? null,
    bulkHeaders: {
      listUnsubscribe: header(resource, "List-Unsubscribe") ?? null,
      listId: header(resource, "List-Id") ?? null,
      precedence: header(resource, "Precedence") ?? null,
      autoSubmitted: header(resource, "Auto-Submitted") ?? null,
    },
    isDsn: isDeliveryStatusReport(contentType?.type, contentType?.params),
    // A payload without `isRead` keeps the stored flags instead of implying unread (and a
    // spurious write-back).
    flags:
      resource.isRead === undefined
        ? undefined
        : [...(resource.isRead ? ["\\Seen"] : []), ...(resource.flag?.flagStatus === "flagged" ? ["\\Flagged"] : [])],
  };
}

class GraphApiError extends Error {
  constructor(public readonly status: number) {
    super(`Graph API request failed with status ${status}`);
  }
}

export interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

/** Attachments follow via upload sessions; Message-ID and reply headers are set so the sent copy keeps them. */
export interface GraphDraft {
  subject: string;
  body: { contentType: "html" | "text"; content: string };
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  bccRecipients: GraphRecipient[];
  internetMessageId: string;
  internetMessageHeaders: { name: string; value: string }[];
}

export interface GraphUploadAttachment {
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentId?: string;
}

/**
 * `sendMail` takes base64 MIME in a request of at most 4 MB (read strictly as 4 000 000 bytes), so
 * raw MIME is capped at 3 000 000 bytes. Larger messages take the draft path.
 */
export const GRAPH_SEND_MAIL_MAX_RAW_BYTES = 3_000_000;

const WRITE_REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_CHUNK_TIMEOUT_MS = 120_000;
const WRITE_ERROR_BODY_READ_LIMIT = 4_096;
/** A create response may carry the whole created message; over this limit the call fails. */
const WRITE_JSON_RESPONSE_LIMIT = 32 * 1024 * 1024;
/** Inferred wording (not confirmed against a live refusal); other wording is an ordinary failure. */
const RECIPIENT_REFUSAL = /ErrorInvalidRecipients|invalid recipient/i;

async function readBodyUpTo(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  return privateSendOperation(() => readSendBody(response, limit));
}

/** Invalid recipient wins over status; 400/401 means reauthorization. Messages never include body or token. */
async function writeFailure(response: Response): Promise<Error> {
  const { text } = await readBodyUpTo(response, WRITE_ERROR_BODY_READ_LIMIT);
  if (RECIPIENT_REFUSAL.test(text)) return new MailRecipientRejectedError();
  if (response.status === 400 || response.status === 401) {
    return new MailReauthorizationRequiredError(`Microsoft Graph rejected the request with status ${response.status}`);
  }
  return new Error(`Microsoft Graph request failed with status ${response.status}`);
}

async function jsonObjectOf(response: Response, context: string): Promise<Record<string, unknown>> {
  const { text, truncated } = await readBodyUpTo(response, WRITE_JSON_RESPONSE_LIMIT);
  if (truncated) throw new Error(`${context} is over the ${WRITE_JSON_RESPONSE_LIMIT}-byte cap`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
  return assertJsonObject(parsed, context);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `GraphMailClient` over Microsoft Graph. `internetMessageHeaders` is `$select`ed to recover
 * `References`/`In-Reply-To`, which Graph does not expose as fields.
 */
export class GraphRestClient implements GraphMailClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    registerGraphMovePreparer(this, (id, destination) => this.prepareMoveMessage(id, destination));
  }

  async observeMoveMessage(messageId: string): Promise<GraphMoveResult> {
    const token = await this.getAccessToken();
    return graphMoveRequest(this.fetchImpl, token, messageId);
  }

  async moveMessage(
    messageId: string,
    destination: "archive" | "deleteditems" | "inbox" | "sentitems",
  ): Promise<GraphMoveResult> {
    return (await prepareGraphMove(this, messageId, destination))();
  }

  private async prepareMoveMessage(
    messageId: string,
    destination: "archive" | "deleteditems" | "inbox" | "sentitems",
  ): Promise<() => Promise<GraphMoveResult>> {
    if (!messageId || messageId.length > 1024) throw new Error("Invalid Graph message identity");
    if (!["archive", "deleteditems", "inbox", "sentitems"].includes(destination))
      throw new Error("Invalid Graph move destination");
    const token = await this.getAccessToken();
    let used = false;
    return () => {
      if (used) throw new Error("Graph move command already used");
      used = true;
      return graphMoveRequest(this.fetchImpl, token, messageId, destination);
    };
  }

  private request<T>(url: string): Promise<T>;
  private request<T>(url: string, tolerated: 404 | 410): Promise<T | null>;
  private async request<T>(url: string, tolerated?: 404 | 410): Promise<T | null> {
    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      void error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Graph sync provider request failed unexpectedly");
    }
    if (response.status === tolerated) return null;
    if (!response.ok) throw new GraphApiError(response.status);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      void error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Graph sync provider response could not be read");
    }
    const body = assertJsonObject(parsed, "Graph API response");
    return body as T;
  }

  private async listAttachmentMetadata(messageId: string): Promise<GraphAttachmentResource[]> {
    // A real 404 means the message disappeared between delta and attachment lookup.
    const page = await this.request<{ value: GraphAttachmentResource[] }>(
      `${BASE_URL}/messages/${messageId}/attachments?$select=id,name,contentType,isInline,contentId`,
      404,
    );
    return page?.value ?? [];
  }

  /** Streams the body without buffering; a counting `Transform` enforces `MAX_ATTACHMENT_BYTES`. */
  private async fetchAttachmentStream(messageId: string, attachmentId: string): Promise<Readable> {
    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE_URL}/messages/${messageId}/attachments/${attachmentId}/$value`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      void error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Graph sync provider request failed unexpectedly");
    }
    if (!response.ok) throw new GraphApiError(response.status);
    let source: Readable;
    try {
      const body = response.body;
      if (!body) throw new Error("Graph attachment response has no body");
      source = Readable.fromWeb(body);
    } catch (error) {
      void error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Graph sync provider response could not be read");
    }
    const observed: unknown[] = [];
    const sourceClosed = new Promise<void>((resolve) => source.once("close", resolve));

    let received = 0;
    let started = false;
    const limiter = new Transform({
      read(size) {
        Transform.prototype._read.call(this, size);
        if (!started) {
          started = true;
          source.pipe(this);
        }
      },
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_ATTACHMENT_BYTES) {
          callback(new Error(`Graph attachment exceeded the ${MAX_ATTACHMENT_BYTES}-byte cap`));
          return;
        }
        callback(null, chunk);
      },
      destroy(error, callback) {
        try {
          if (!source.destroyed) source.destroy();
        } catch (cleanupError) {
          observed.push(cleanupError);
          // Do not report a terminal result before the owned source actually closes.
          void sourceClosed.then(() => callback(error ?? new Error("Graph sync provider stream could not be closed")));
          return;
        }
        void sourceClosed.then(() => {
          void observed;
          callback(error);
        });
      },
    });
    // `.pipe()` does not forward source errors; without this a dropped connection would hang consumers.
    source.on("error", (error: unknown) => {
      observed.push(error);
      limiter.destroy(new Error("Graph sync provider response could not be read"));
    });
    return limiter;
  }

  /** `/mailFolders` returns one level, so nesting needs a recursive walk; `depth` caps a malformed response. */
  private async listFoldersUnder(url: string, wellKnownIds: Map<string, string>, depth = 0): Promise<GraphFolderRef[]> {
    if (depth > 50) throw new Error("Graph mailFolders tree exceeded depth 50");
    const folders: GraphFolderRef[] = [];
    let pageUrl = url;
    while (pageUrl) {
      const page = await this.request<{
        value: { id: string; displayName: string; childFolderCount?: number }[];
        ["@odata.nextLink"]?: string;
      }>(pageUrl);
      for (const f of page.value) {
        folders.push({ id: f.id, displayName: f.displayName, wellKnownName: wellKnownIds.get(f.id) });
        if (f.childFolderCount && f.childFolderCount > 0) {
          folders.push(
            ...(await this.listFoldersUnder(
              `${BASE_URL}/mailFolders/${f.id}/childFolders?$top=999&$select=id,displayName,childFolderCount`,
              wellKnownIds,
              depth + 1,
            )),
          );
        }
      }
      pageUrl = page["@odata.nextLink"] ?? "";
    }
    return folders;
  }

  async listFolders(): Promise<GraphFolderRef[]> {
    const wellKnownIds = new Map<string, string>();
    for (const name of WELL_KNOWN_FOLDERS) {
      const folder = await this.request<{ id: string }>(`${BASE_URL}/mailFolders/${name}`, 404);
      if (folder) wellKnownIds.set(folder.id, name);
    }

    return this.listFoldersUnder(
      `${BASE_URL}/mailFolders?$top=999&$select=id,displayName,childFolderCount`,
      wellKnownIds,
    );
  }

  async fetchDelta(deltaLink: string | null): Promise<GraphDeltaResult> {
    let url =
      deltaLink ??
      `${BASE_URL}/messages/delta?$select=internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,body,bodyPreview,receivedDateTime,parentFolderId,internetMessageHeaders,hasAttachments,isRead,flag`;
    const changes: GraphChangedMessage[] = [];
    let newDeltaLink = "";

    while (url) {
      const page = await this.request<{
        value: GraphMessageResource[];
        ["@odata.nextLink"]?: string;
        ["@odata.deltaLink"]?: string;
      }>(url, 410);
      if (!page) return { invalidated: true, newDeltaLink: "", changes: [] };
      for (const resource of page.value) {
        if (resource["@removed"]) {
          changes.push({ id: resource.id, removed: true });
        } else {
          const message = await toFetchedGraphMessage(
            resource,
            (messageId) => this.listAttachmentMetadata(messageId),
            (messageId, attachmentId) => this.fetchAttachmentStream(messageId, attachmentId),
          );
          changes.push({ id: resource.id, parentFolderId: resource.parentFolderId, removed: false, message });
        }
      }
      if (page["@odata.deltaLink"]) newDeltaLink = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    }

    return { invalidated: false, newDeltaLink, changes };
  }

  async patchMessage(
    messageId: string,
    patch: { isRead: boolean } | { flag: { flagStatus: "flagged" | "notFlagged" } },
  ): Promise<void> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${BASE_URL}/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new GraphApiError(response.status);
    await response.body?.cancel();
  }

  private async writeRequest(
    url: string,
    init: { method: "POST" | "DELETE"; body?: string; contentType?: string },
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const response = await privateSendOperation(() =>
      this.fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.contentType ? { "Content-Type": init.contentType } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(WRITE_REQUEST_TIMEOUT_MS),
      }),
    );
    if (!response.ok) throw await privateSendOperation(() => writeFailure(response));
    return response;
  }

  /** Graph files the Sent copy itself and answers 202 with no body. */
  async sendMime(raw: Buffer): Promise<void> {
    if (raw.byteLength > GRAPH_SEND_MAIL_MAX_RAW_BYTES) throw new Error("Graph MIME exceeds the send body budget");
    const response = await this.writeRequest(`${BASE_URL}/sendMail`, {
      method: "POST",
      body: raw.toString("base64"),
      contentType: "text/plain",
    });
    try {
      await response.body?.cancel();
    } catch (error) {
      void error;
      reportSendCleanupFailure("graph-send-response");
    }
  }

  async createDraft(draft: GraphDraft): Promise<{ id: string }> {
    const response = await this.writeRequest(`${BASE_URL}/messages`, {
      method: "POST",
      body: JSON.stringify(draft),
      contentType: "application/json",
    });
    const json = await jsonObjectOf(response, "Microsoft Graph draft response");
    if (typeof json.id !== "string" || !json.id) throw new Error("Microsoft Graph draft response has no message id");
    return { id: json.id };
  }

  /** A non-HTTPS upload URL is refused before any byte is sent to it. */
  async createUploadSession(draftId: string, attachment: GraphUploadAttachment): Promise<{ uploadUrl: string }> {
    const response = await this.writeRequest(
      `${BASE_URL}/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
      {
        method: "POST",
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: "file",
            name: attachment.name,
            size: attachment.size,
            isInline: attachment.isInline,
            contentType: attachment.contentType,
            contentId: attachment.contentId,
          },
        }),
        contentType: "application/json",
      },
    );
    const json = await jsonObjectOf(response, "Microsoft Graph upload session response");
    if (typeof json.uploadUrl !== "string")
      throw new Error("Microsoft Graph upload session response has no upload URL");
    if (!isHttpsUrl(json.uploadUrl)) throw new Error("Microsoft Graph returned an upload URL that is not HTTPS");
    return { uploadUrl: json.uploadUrl };
  }

  /** Upload URLs are pre-authenticated: no bearer token is sent, and a refusal is not a credential failure. */
  async uploadChunk(uploadUrl: string, chunk: Buffer, start: number, total: number): Promise<void> {
    const response = await privateSendOperation(() =>
      this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${start}-${start + chunk.byteLength - 1}/${total}` },
        body: chunk,
        signal: AbortSignal.timeout(UPLOAD_CHUNK_TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch (error) {
        void error;
        reportSendCleanupFailure("graph-upload-response");
      }
      throw new Error(`Microsoft Graph upload failed with status ${response.status}`);
    }
    await privateSendOperation(async () => {
      await response.body?.cancel();
    });
  }

  async sendDraft(draftId: string): Promise<void> {
    const response = await this.writeRequest(`${BASE_URL}/messages/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
    });
    try {
      await response.body?.cancel();
    } catch (error) {
      void error;
      reportSendCleanupFailure("graph-send-response");
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    const response = await this.writeRequest(`${BASE_URL}/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
    await privateSendOperation(async () => {
      await response.body?.cancel();
    });
  }
}
