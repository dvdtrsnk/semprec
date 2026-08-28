import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { ClassifiedAttachment } from "./attachments.js";
import type { GraphChangedMessage, GraphDeltaResult, GraphFolderRef, GraphMailClient } from "./graphReconcile.js";
import { assertJsonObject, type FetchedMessage } from "./providerTypes.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

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
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  receivedDateTime?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  hasAttachments?: boolean;
  ["@removed"]?: { reason: string };
}

/** `/messages/{id}/attachments` resource — `fileAttachment` is the common real-world case this adapter handles; `itemAttachment`/`referenceAttachment` (a forwarded calendar item, a OneDrive share link) are rare enough that issue #26's scope doesn't ask for them. */
interface GraphAttachmentResource {
  ["@odata.type"]: string;
  id: string;
  name: string;
  contentType?: string;
  isInline?: boolean;
  contentId?: string;
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
      filename: m.name || "attachment",
      contentType: m.contentType || "application/octet-stream",
      contentId: m.contentId ?? null,
      disposition: m.isInline ? "inline" : "attachment",
      openStream: () => fetchAttachmentStream(m.id),
    }));
  // Same "inline part actually referenced via cid: in the HTML body is a rendering asset, not
  // a document" rule the other two adapters apply (attachments.ts / imapFlowClient.ts).
  return candidates.filter((a) => !(a.disposition === "inline" && a.contentId !== null && Boolean(html?.includes(`cid:${a.contentId}`))));
}

async function toFetchedMessage(
  resource: GraphMessageResource,
  listAttachmentMetadata: (messageId: string) => Promise<GraphAttachmentResource[]>,
  fetchAttachmentStream: (messageId: string, attachmentId: string) => Promise<Readable>,
): Promise<FetchedMessage> {
  const referencesHeader = header(resource, "References");
  const html = resource.body?.contentType === "html" ? resource.body.content : undefined;
  const attachmentMetas = resource.hasAttachments ? await listAttachmentMetadata(resource.id) : [];
  const attachments = classifyGraphAttachments((attachmentId) => fetchAttachmentStream(resource.id, attachmentId), attachmentMetas, html);

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
    },
    bodyText: resource.body?.contentType === "text" ? resource.body.content : resource.bodyPreview,
    bodyHtml: html,
    date: resource.receivedDateTime ? new Date(resource.receivedDateTime) : undefined,
    attachments,
  };
}

class GraphApiError extends Error {
  constructor(public readonly status: number) {
    super(`Graph API request failed with status ${status}`);
  }
}

/**
 * Real `GraphMailClient` (graphReconcile.ts) over the Microsoft Graph REST API — same
 * "not exercised by tests, reconcile logic tested via a fake" relationship as
 * `GmailRestClient`. `internetMessageHeaders` is requested via `$select` (Graph has no
 * separate "which headers" query parameter — it must be a selected property, same as any
 * other field) specifically to recover `References`/`In-Reply-To`, which Graph doesn't
 * surface as first-class fields.
 */
export class GraphRestClient implements GraphMailClient {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  private async request<T>(url: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new GraphApiError(response.status);
    const body = assertJsonObject(await response.json(), `Graph API response from ${url}`);
    return body as T;
  }

  private async listAttachmentMetadata(messageId: string): Promise<GraphAttachmentResource[]> {
    try {
      const page = await this.request<{ value: GraphAttachmentResource[] }>(
        `${BASE_URL}/messages/${messageId}/attachments?$select=id,name,contentType,isInline,contentId`,
      );
      return page.value;
    } catch (err) {
      // The message can be deleted between the delta page that listed it and this follow-up
      // fetch (a real race in a live mailbox) — a 404 here means "nothing to attach anymore,"
      // not a sync failure; the message itself getting removed is handled separately, by a
      // later delta page's own `@removed` entry.
      if (err instanceof GraphApiError && err.status === 404) return [];
      throw err;
    }
  }

  /** Streams raw bytes directly from the response body — never materializes the attachment as one in-memory buffer, the same memory-safety property imapflow's `download()` gives the IMAP adapter. */
  private async fetchAttachmentStream(messageId: string, attachmentId: string): Promise<Readable> {
    const token = await this.getAccessToken();
    const response = await fetch(`${BASE_URL}/messages/${messageId}/attachments/${attachmentId}/$value`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new GraphApiError(response.status);
    if (!response.body) throw new Error(`Graph attachment ${attachmentId} on message ${messageId} returned no body`);
    return Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
  }

  /**
   * Graph's `/mailFolders` (and `/childFolders`) only ever return one level — nested folders
   * need an explicit recursive walk, not a single `$expand`. `depth` bounds that walk: a real
   * mailbox's folder tree is at most a handful of levels deep, so this is a defensive cap
   * against a malformed/adversarial API response reporting `childFolderCount > 0` on every
   * node, not a limit expected to ever bind in practice.
   */
  private async listFoldersUnder(url: string, wellKnownIds: Map<string, string>, depth = 0): Promise<GraphFolderRef[]> {
    if (depth > 50) throw new Error(`Graph mailFolders tree exceeded depth 50 under ${url} — likely a malformed API response`);
    const folders: GraphFolderRef[] = [];
    let pageUrl = url;
    while (pageUrl) {
      const page = await this.request<{ value: { id: string; displayName: string; childFolderCount?: number }[]; ["@odata.nextLink"]?: string }>(pageUrl);
      for (const f of page.value) {
        folders.push({ id: f.id, displayName: f.displayName, wellKnownName: wellKnownIds.get(f.id) });
        if (f.childFolderCount && f.childFolderCount > 0) {
          folders.push(
            ...(await this.listFoldersUnder(`${BASE_URL}/mailFolders/${f.id}/childFolders?$top=999&$select=id,displayName,childFolderCount`, wellKnownIds, depth + 1)),
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
      try {
        const folder = await this.request<{ id: string }>(`${BASE_URL}/mailFolders/${name}`);
        wellKnownIds.set(folder.id, name);
      } catch {
        // Not every well-known folder exists for every account (e.g. no Archive) — skip.
      }
    }

    return this.listFoldersUnder(`${BASE_URL}/mailFolders?$top=999&$select=id,displayName,childFolderCount`, wellKnownIds);
  }

  async fetchDelta(deltaLink: string | null): Promise<GraphDeltaResult> {
    let url =
      deltaLink ??
      `${BASE_URL}/messages/delta?$select=internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,body,bodyPreview,receivedDateTime,parentFolderId,internetMessageHeaders,hasAttachments`;
    const changes: GraphChangedMessage[] = [];
    let newDeltaLink = "";

    try {
      while (url) {
        const page = await this.request<{ value: GraphMessageResource[]; ["@odata.nextLink"]?: string; ["@odata.deltaLink"]?: string }>(url);
        for (const resource of page.value) {
          if (resource["@removed"]) {
            changes.push({ id: resource.id, removed: true });
          } else {
            const message = await toFetchedMessage(
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
    } catch (err) {
      // 410 Gone is Graph's documented "deltaLink expired, resync required" response —
      // matched on the actual HTTP status, not a substring of the error message, so an
      // unrelated 4xx (a malformed query, throttling) surfaces as a real error instead of
      // silently discarding the account's sync position.
      if (err instanceof GraphApiError && err.status === 410) {
        return { invalidated: true, newDeltaLink: "", changes: [] };
      }
      throw err;
    }

    return { invalidated: false, newDeltaLink, changes };
  }
}
