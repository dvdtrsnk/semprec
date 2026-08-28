import type { ClassifiedAttachment } from "./attachments.js";
import type { GraphChangedMessage, GraphDeltaResult, GraphFolderRef, GraphMailClient } from "./graphReconcile.js";
import type { FetchedMessage } from "./providerTypes.js";
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
  ["@removed"]?: { reason: string };
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

async function toFetchedMessage(resource: GraphMessageResource): Promise<FetchedMessage> {
  const referencesHeader = header(resource, "References");
  const html = resource.body?.contentType === "html" ? resource.body.content : undefined;
  // Graph's REST body doesn't expose raw MIME parts for attachments in this call; a real
  // deployment fetches `/messages/{id}/attachments` separately and classifies them the same
  // way as the other two adapters (see attachments.ts) — a second request this compact
  // client doesn't make, so attachments are omitted here.
  const attachments: ClassifiedAttachment[] = [];

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
    return (await response.json()) as T;
  }

  /** Graph's `/mailFolders` (and `/childFolders`) only ever return one level — nested folders need an explicit recursive walk, not a single `$expand`. */
  private async listFoldersUnder(url: string, wellKnownIds: Map<string, string>): Promise<GraphFolderRef[]> {
    const folders: GraphFolderRef[] = [];
    let pageUrl = url;
    while (pageUrl) {
      const page = await this.request<{ value: { id: string; displayName: string; childFolderCount?: number }[]; ["@odata.nextLink"]?: string }>(pageUrl);
      for (const f of page.value) {
        folders.push({ id: f.id, displayName: f.displayName, wellKnownName: wellKnownIds.get(f.id) });
        if (f.childFolderCount && f.childFolderCount > 0) {
          folders.push(...(await this.listFoldersUnder(`${BASE_URL}/mailFolders/${f.id}/childFolders?$top=999&$select=id,displayName,childFolderCount`, wellKnownIds)));
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
      `${BASE_URL}/messages/delta?$select=internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,body,bodyPreview,receivedDateTime,parentFolderId,internetMessageHeaders`;
    const changes: GraphChangedMessage[] = [];
    let newDeltaLink = "";

    try {
      while (url) {
        const page = await this.request<{ value: GraphMessageResource[]; ["@odata.nextLink"]?: string; ["@odata.deltaLink"]?: string }>(url);
        for (const resource of page.value) {
          if (resource["@removed"]) {
            changes.push({ id: resource.id, removed: true });
          } else {
            changes.push({ id: resource.id, parentFolderId: resource.parentFolderId, removed: false, message: await toFetchedMessage(resource) });
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
