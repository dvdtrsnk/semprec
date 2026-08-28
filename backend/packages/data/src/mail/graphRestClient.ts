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

/**
 * Real `GraphMailClient` (graphReconcile.ts) over the Microsoft Graph REST API — same
 * "not exercised by tests, reconcile logic tested via a fake" relationship as
 * `GmailRestClient`. Requests `internetMessageHeaders` on the delta query specifically to
 * recover `References`/`In-Reply-To` (Graph doesn't surface these as first-class fields).
 */
export class GraphRestClient implements GraphMailClient {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  private async request<T>(url: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Graph API request failed with status ${response.status}`);
    return (await response.json()) as T;
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

    const folders: GraphFolderRef[] = [];
    let url = `${BASE_URL}/mailFolders?$top=999`;
    while (url) {
      const page = await this.request<{ value: { id: string; displayName: string }[]; ["@odata.nextLink"]?: string }>(url);
      for (const f of page.value) folders.push({ id: f.id, displayName: f.displayName, wellKnownName: wellKnownIds.get(f.id) });
      url = page["@odata.nextLink"] ?? "";
    }
    return folders;
  }

  async fetchDelta(deltaLink: string | null): Promise<GraphDeltaResult> {
    let url =
      deltaLink ??
      `${BASE_URL}/messages/delta?$select=internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,body,bodyPreview,receivedDateTime,parentFolderId&$expand=singleValueExtendedProperties($filter=id eq 'String 0x1042')&$headers=internetMessageHeaders`;
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
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("410") || message.includes("400")) {
        return { invalidated: true, newDeltaLink: "", changes: [] };
      }
      throw err;
    }

    return { invalidated: false, newDeltaLink, changes };
  }
}
