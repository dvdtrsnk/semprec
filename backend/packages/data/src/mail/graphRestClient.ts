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

/** `/messages/{id}/attachments` resource. */
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

/** Every occurrence of a header on this message (`internetMessageHeaders` preserves repeats, unlike `header`'s single-match lookup above) — needed for "highest Delivered-To occurrence" (mail/deliveredTo.ts, issue #93). */
function headerValues(resource: GraphMessageResource, name: string): string[] {
  return (resource.internetMessageHeaders ?? [])
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value);
}

function safeAttachmentLabel(name: unknown): string {
  // Graph attachment names are untrusted input. Remove control characters so the text form
  // cannot forge extra annotations, and escape the HTML form before it joins the stored body.
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

/**
 * Builds each candidate attachment's lazy byte source over Graph's `/attachments/{id}/$value`
 * — unlike the Gmail REST API (gmailRestClient.ts), Graph's `$value` is a true streamed byte
 * response (not a JSON-wrapped base64 blob), so `openStream` here never buffers the whole part
 * either, the same as the IMAP adapter's `download()`-backed streams.
 */
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
  // Same "inline part actually referenced via cid: in the HTML body is a rendering asset, not
  // a document" rule the other two adapters apply (attachments.ts / imapFlowClient.ts).
  return candidates.filter(
    (a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))),
  );
}

/**
 * Graph has no bytes to stream for item/reference attachments. They are retained as literal
 * body annotations rather than synthesized Files rows, so repeated delta reconciliation
 * converges through ingestEmailMessage's message identity deduplication just like the body.
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
    // Delta links created before `isRead` was added to our `$select` do not carry that field.
    // Preserve the stored observation in that case instead of treating the incomplete payload
    // as an explicit unread state and scheduling a spurious provider write-back.
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

/** A Graph recipient in the `emailAddress` shape that `createDraft` takes. */
export interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

/**
 * The draft `createDraft` posts: the message without its attachments, which follow through upload sessions.
 * `internetMessageId` and the reply headers are set on the draft so that the sent copy keeps them.
 */
export interface GraphDraft {
  subject: string;
  body: { contentType: "html" | "text"; content: string };
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  bccRecipients: GraphRecipient[];
  internetMessageId: string;
  internetMessageHeaders: { name: string; value: string }[];
}

/** One attachment of a draft, as `createUploadSession` describes it. */
export interface GraphUploadAttachment {
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentId?: string;
}

/**
 * The largest raw MIME `sendMime` takes. `sendMail` carries the MIME base64 encoded in a request of at most 4 MB.
 * Read as 4 000 000 bytes, the stricter of the two readings, and since base64 turns every 3 raw bytes into 4
 * characters, the largest raw message is 3 000 000 bytes. Larger messages take the draft path (graphTransport.ts).
 */
export const GRAPH_SEND_MAIL_MAX_RAW_BYTES = 3_000_000;

const WRITE_REQUEST_TIMEOUT_MS = 30_000;
/** An upload chunk is larger than a metadata call, so its deadline is longer. */
const UPLOAD_CHUNK_TIMEOUT_MS = 120_000;
/** The most of a failed write's body that is read. It is read only to tell a refused recipient apart from other refusals. */
const WRITE_ERROR_BODY_READ_LIMIT = 4_096;
/**
 * The most of a successful write's JSON body that is read. A create response may carry the created message, body
 * included, so this limit sits well above what a draft id needs. A response over it fails the call instead of being cut short.
 */
const WRITE_JSON_RESPONSE_LIMIT = 32 * 1024 * 1024;
/**
 * Graph text that names a refused recipient. The wording is inferred from Graph's error codes; no live refusal has
 * been captured to confirm it, so a refusal worded differently is an ordinary failure.
 */
const RECIPIENT_REFUSAL = /ErrorInvalidRecipients|invalid recipient/i;

/**
 * Reads at most `limit` bytes of a response body and then releases the stream. Releasing is cleanup: its failure is
 * dropped, because the outcome of the read is what the caller needs.
 */
async function readBodyUpTo(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  return privateSendOperation(() => readSendBody(response, limit));
}

/**
 * The error a refused Graph write with a bearer token becomes. A refusal that names an invalid recipient is
 * `MailRecipientRejectedError` whatever its status. Otherwise a 400 or 401 is `MailReauthorizationRequiredError`, and
 * any other status is an ordinary failure. The messages name neither the body nor any token.
 */
async function writeFailure(response: Response): Promise<Error> {
  const { text } = await readBodyUpTo(response, WRITE_ERROR_BODY_READ_LIMIT);
  if (RECIPIENT_REFUSAL.test(text)) return new MailRecipientRejectedError();
  if (response.status === 400 || response.status === 401) {
    return new MailReauthorizationRequiredError(`Microsoft Graph rejected the request with status ${response.status}`);
  }
  return new Error(`Microsoft Graph request failed with status ${response.status}`);
}

/** Parses the JSON object of a successful write. A body over the limit fails the call instead of being parsed short. */
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
 * Real `GraphMailClient` (graphReconcile.ts) over the Microsoft Graph REST API. CI never reaches
 * Microsoft: the semprec-api tests in `mailSyncAdapters.test.ts` run it against a fake Graph server
 * through `fetchImpl`, and the reconcile logic itself is tested against a fake client. `fetchImpl`
 * defaults to the global `fetch`. `internetMessageHeaders` is requested via `$select` (Graph has no
 * separate "which headers" query parameter — it must be a selected property, same as any
 * other field) specifically to recover `References`/`In-Reply-To`, which Graph doesn't
 * surface as first-class fields.
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

  /**
   * Streams raw bytes directly from the response body — never materializes the attachment as
   * one in-memory buffer, the same memory-safety property imapflow's `download()` gives the
   * IMAP adapter. Unlike `download()`, `fetch`'s web stream has no built-in byte cap of its
   * own, so a `MAX_ATTACHMENT_BYTES`-counting `Transform` is spliced into the returned stream
   * — the same backstop the IMAP/Gmail adapters get from their own transports.
   */
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
    // Plain `.pipe()` does not forward the source's own 'error' event to the destination — a
    // dropped connection mid-transfer would otherwise leave `limiter` (and whatever later
    // consumes it, e.g. blobStorage.ts's `pipeline()`) waiting forever instead of erroring out,
    // the same class of bug this codebase already documents for imapflow's own download() path.
    source.on("error", (error: unknown) => {
      observed.push(error);
      limiter.destroy(new Error("Graph sync provider response could not be read"));
    });
    return limiter;
  }

  /**
   * Graph's `/mailFolders` (and `/childFolders`) only ever return one level — nested folders
   * need an explicit recursive walk, not a single `$expand`. `depth` bounds that walk: a real
   * mailbox's folder tree is at most a handful of levels deep, so this is a defensive cap
   * against a malformed/adversarial API response reporting `childFolderCount > 0` on every
   * node, not a limit expected to ever bind in practice.
   */
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

  /** A write with a bearer token. A failed status becomes the error `writeFailure` classifies; a success returns the response. */
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

  /**
   * Sends a complete RFC 5322 message with `POST /me/sendMail`, base64 encoded as Graph requires for MIME. Graph files
   * the Sent copy itself and answers 202 with no body. The caller keeps `raw` within GRAPH_SEND_MAIL_MAX_RAW_BYTES.
   */
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

  /** Creates a draft that carries the Message-ID and the reply headers. Returns the draft's id. */
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

  /**
   * Opens an upload session for one attachment of a draft. Returns its upload URL. The URL must be HTTPS. One that is
   * not is refused before any byte is sent to it.
   */
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

  /**
   * Writes one chunk of an upload session with `PUT`. `start` is the chunk's offset in the attachment and `total` is the
   * attachment's size. An upload URL is pre-authenticated, so no bearer token is sent to it, and a refusal is an ordinary
   * failure rather than a credential one.
   */
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

  /** Sends a draft with `POST /me/messages/{id}/send`. Graph files the sent copy itself. */
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

  /** Deletes a message, here a draft that a failed large send left behind. */
  async deleteMessage(messageId: string): Promise<void> {
    const response = await this.writeRequest(`${BASE_URL}/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
    await privateSendOperation(async () => {
      await response.body?.cancel();
    });
  }
}
