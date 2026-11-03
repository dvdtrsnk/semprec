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

/** Names the send's token refreshes in `credential_access_log`, next to `graph_api_sync` for the sync pass. */
export const GRAPH_SEND_PURPOSE = "graph_api_send";

/** The size of each upload chunk. Graph wants the chunks of an upload session in multiples of 320 KiB; 5 MiB is 16 of them. */
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

export interface GraphMailTransportOptions {
  pool: Pool;
  mailboxItemId: string;
  clientId: string;
  clientSecret: string;
  /** Replaces the global `fetch` for the token endpoint and the Graph API. Tests inject a fake Microsoft here. */
  fetchImpl?: typeof fetch;
}

/**
 * The transport of a `graph_api` mailbox. A message of at most GRAPH_SEND_MAIL_MAX_RAW_BYTES goes through `sendMail`
 * as its MIME. A larger one takes the draft path: the draft is created with the message's Message-ID and reply headers,
 * each attachment is uploaded through an upload session in chunks, and the draft is sent. Every Graph request refreshes
 * the access token first (`refreshAndPersistAccessToken`), as the Gmail transport does, so no token outlives the request
 * that obtained it. A failure after the draft exists deletes the draft, best effort.
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
 * The large path. The MIME is parsed before anything is created, so a message this path cannot send (no Message-ID, or an
 * empty attachment, whose zero chunks the upload loop would drop without a trace) fails without leaving a draft behind.
 * From the moment the draft exists, any failure deletes it, best effort, and the caller receives the send's own error.
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

/** The draft of a parsed message: its content, its recipients and the headers that keep it in its conversation. */
function draftOf(parsed: ParsedMail, messageId: string, envelopeRecipients: string[]): GraphDraft {
  const to = recipientsOf(parsed.to);
  const cc = recipientsOf(parsed.cc);
  // The MIME has no Bcc header, so the envelope is the only record of a bcc recipient. An envelope address that To and
  // Cc do not name is one.
  const headerAddresses = new Set([...to, ...cc].map((recipient) => recipient.emailAddress.address.toLowerCase()));
  const bcc: GraphRecipient[] = envelopeRecipients
    .filter((address) => !headerAddresses.has(address.toLowerCase()))
    .map((address) => ({ emailAddress: { address } }));
  // mailparser gives References as a string for one id and an array for several. Wrapping it in an array handles both.
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

/** One address field of a parsed message. mailparser gives one address object for one header and an array for several. */
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

/**
 * Deletes the draft a failed send left behind. A failure is reported with a fixed cleanup stage, while the send's own
 * error remains the one that propagates.
 */
async function deleteDraftBestEffort(client: GraphRestClient, draftId: string): Promise<void> {
  try {
    await client.deleteMessage(draftId);
  } catch (error) {
    void error;
    reportSendCleanupFailure("graph-draft-delete");
  }
}
