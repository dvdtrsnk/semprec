import { simpleParser } from "mailparser";
import { classifyAttachments } from "./attachments.js";
import type { GmailFetchedMessage, GmailHistoryResult, GmailLabelRef, GmailMailClient } from "./gmailReconcile.js";
import { normalizeMessageId, type FetchedMessage } from "./providerTypes.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { readJsonWithLimit } from "./httpJson.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function parseRawMessage(raw: string, gmailMessageId: string): Promise<FetchedMessage> {
  const parsed = await simpleParser(decodeBase64Url(raw), { keepCidLinks: true });
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const toList = (value: typeof parsed.to): MailEnvelopeAddress[] => {
    const objects = Array.isArray(value) ? value : value ? [value] : [];
    return objects.flatMap((o) => o.value).filter((a): a is { name: string; address: string } => Boolean(a.address)).map((a) => ({ name: a.name || undefined, address: a.address }));
  };
  return {
    // Falls back to Gmail's own (always-unique) message id, not a fixed placeholder — two
    // different messages both missing a Message-ID header must not collide and get merged
    // into one Emails item by ingestEmailMessage's dedup-by-messageId.
    messageId: normalizeMessageId(parsed.messageId ?? `<${gmailMessageId}@gmail-api>`),
    inReplyTo: parsed.inReplyTo ? normalizeMessageId(parsed.inReplyTo) : null,
    references: references.map(normalizeMessageId),
    subject: parsed.subject,
    envelope: {
      from: parsed.from?.value[0]?.address ? { name: parsed.from.value[0].name || undefined, address: parsed.from.value[0].address } : undefined,
      to: toList(parsed.to),
      cc: toList(parsed.cc),
      bcc: toList(parsed.bcc),
    },
    bodyText: parsed.text,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
    date: parsed.date,
    attachments: classifyAttachments(parsed),
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
    return { status: response.status, json: await readJsonWithLimit<T>(response) };
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

  async fetchMessage(id: string): Promise<GmailFetchedMessage | null> {
    const { status, json } = await this.request<{ id: string; threadId: string; labelIds?: string[]; raw: string }>(`/messages/${id}?format=raw`);
    if (status === 404 || !json) return null;
    return { id: json.id, threadId: json.threadId, labelIds: json.labelIds ?? [], message: await parseRawMessage(json.raw, json.id) };
  }

  async listLabels(): Promise<GmailLabelRef[]> {
    const { json } = await this.request<{ labels?: { id: string; name: string; type: string }[] }>("/labels");
    return (json?.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type === "system" ? "system" : "user" }));
  }
}
