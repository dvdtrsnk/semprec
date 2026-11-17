import type { Pool } from "pg";
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from "mailparser";
import {
  GRAPH_SEND_MAIL_MAX_RAW_BYTES,
  GraphRestClient,
  type GraphDraft,
  type GraphRecipient,
  type GraphUploadAttachment,
} from "./graphRestClient.js";
import { privateSendOperation, reportSendCleanupFailure } from "./mailSendPrivacy.js";
import { refreshAndPersistAccessToken } from "./mailOAuthAccess.js";
import { MICROSOFT_TOKEN_URL } from "./oauthTokenExchange.js";
import type { MailTransport, MailTransportMessage } from "./mailTransport.js";

/** The `credential_access_log` purpose of a send's token refreshes. */
export const GRAPH_SEND_PURPOSE = "graph_api_send";

/** Graph requires upload chunks in multiples of 320 KiB; 5 MiB is 16 of them. */
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

export interface GraphMailTransportOptions {
  pool: Pool;
  mailboxItemId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Small messages go through `sendMail` as MIME; larger ones via a draft with chunked attachment
 * uploads. Every request refreshes the access token first, so no token outlives its request.
 */
export function createGraphMailTransport(options: GraphMailTransportOptions): MailTransport {
  const { pool, mailboxItemId, clientId, clientSecret, fetchImpl } = options;
  return {
    async send(message) {
      const client = new GraphRestClient(async () => {
        const { accessToken } = await refreshAndPersistAccessToken(pool, {
          mailboxItemId,
          tokenUrl: MICROSOFT_TOKEN_URL,
          clientId,
          clientSecret,
          purpose: GRAPH_SEND_PURPOSE,
          fetchImpl,
        });
        return accessToken;
      }, fetchImpl);
      if (message.raw.byteLength <= GRAPH_SEND_MAIL_MAX_RAW_BYTES) {
        await client.sendMime(message.raw);
      } else {
        await sendAsDraft(client, message);
      }
      return {};
    },
  };
}

/**
 * Unsendable messages (no Message-ID, or an empty attachment the upload loop would silently drop)
 * fail before a draft exists. Afterwards any failure deletes the draft best effort and rethrows
 * the send's own error.
 */
async function sendAsDraft(client: GraphRestClient, message: MailTransportMessage): Promise<void> {
  const parsed = await privateSendOperation(() => simpleParser(message.raw, { keepCidLinks: true }));
  const messageId = parsed.messageId;
  if (!messageId) throw new Error("The outgoing message has no Message-ID to keep");
  for (const attachment of parsed.attachments) {
    if (attachment.content.byteLength === 0) {
      throw new Error("An attachment of the outgoing message is empty and cannot be uploaded to Microsoft Graph");
    }
  }

  const draft = await client.createDraft(draftOf(parsed, messageId, message.envelope.recipients));
  try {
    for (const attachment of parsed.attachments) {
      const { uploadUrl } = await client.createUploadSession(draft.id, uploadOf(attachment));
      await uploadInChunks(client, uploadUrl, attachment.content);
    }
    await client.sendDraft(draft.id);
  } catch (error) {
    await deleteDraftBestEffort(client, draft.id);
    throw error;
  }
}

function draftOf(parsed: ParsedMail, messageId: string, envelopeRecipients: string[]): GraphDraft {
  const to = recipientsOf(parsed.to);
  const cc = recipientsOf(parsed.cc);
  // The MIME has no Bcc header: any envelope address not in To/Cc is a bcc recipient.
  const headerAddresses = new Set([...to, ...cc].map((recipient) => recipient.emailAddress.address.toLowerCase()));
  const bcc: GraphRecipient[] = envelopeRecipients
    .filter((address) => !headerAddresses.has(address.toLowerCase()))
    .map((address) => ({ emailAddress: { address } }));
  // mailparser returns a string for one reference and an array for several.
  const references = [parsed.references ?? []].flat().join(" ");
  return {
    subject: parsed.subject ?? "",
    body:
      typeof parsed.html === "string"
        ? { contentType: "html", content: parsed.html }
        : { contentType: "text", content: parsed.text ?? "" },
    toRecipients: to,
    ccRecipients: cc,
    bccRecipients: bcc,
    internetMessageId: messageId,
    internetMessageHeaders: [
      ...(parsed.inReplyTo ? [{ name: "In-Reply-To", value: parsed.inReplyTo }] : []),
      ...(references ? [{ name: "References", value: references }] : []),
    ],
  };
}

function recipientsOf(field: AddressObject | AddressObject[] | undefined): GraphRecipient[] {
  const objects: AddressObject[] = [];
  return objects
    .concat(field ?? [])
    .flatMap((object) => object.value)
    .flatMap((entry): GraphRecipient[] =>
      entry.address ? [{ emailAddress: { address: entry.address, ...(entry.name ? { name: entry.name } : {}) } }] : [],
    );
}

function uploadOf(attachment: Attachment): GraphUploadAttachment {
  return {
    name: attachment.filename || "attachment",
    contentType: attachment.contentType,
    size: attachment.content.byteLength,
    isInline: attachment.contentDisposition === "inline",
    ...(attachment.cid ? { contentId: attachment.cid } : {}),
  };
}

async function uploadInChunks(client: GraphRestClient, uploadUrl: string, content: Buffer): Promise<void> {
  for (let start = 0; start < content.byteLength; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, content.byteLength);
    await client.uploadChunk(uploadUrl, content.subarray(start, end), start, content.byteLength);
  }
}

/** A cleanup failure is only reported; the send's own error is the one that propagates. */
async function deleteDraftBestEffort(client: GraphRestClient, draftId: string): Promise<void> {
  try {
    await client.deleteMessage(draftId);
  } catch (error) {
    void error;
    reportSendCleanupFailure("graph-draft-delete");
  }
}
