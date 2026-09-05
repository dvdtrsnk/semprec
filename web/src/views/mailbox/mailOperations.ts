import { z } from "zod";
import { toOperationError, type GenericOperations, type Item } from "../../api/genericOperations.js";
import { parseAddress, parseAddressList, type MailAddress } from "./addresses.js";

/**
 * The mail module's named operations, as the compose surface calls them. Reading stays on the
 * generic operations (folders, messages, mailboxes are ordinary items); these three are the
 * cases a generic call cannot express:
 *
 * - `email.message.envelope` reads the structured From/To/Cc/Bcc and threading headers of a
 *   message. They live in the mail module's own `mail_message_meta` row, not in the item's
 *   properties — `sender`/`recipients` there are derived display text (seedEmailModule.ts) —
 *   so a reply-all built from properties alone would silently lose Cc and every display name.
 * - `email.draft.create` creates the draft item and links it into Drafts (mail/draft.ts).
 * - `email.send` submits over the mailbox's SMTP credentials (mail/send.ts) and moves the
 *   draft into Sent. Which folders and property ids that involves is the module's business:
 *   the client names the mailbox and the draft, never a database or a relation property.
 */
export const EMAIL_MESSAGE_ENVELOPE_OPERATION = "email.message.envelope";
export const EMAIL_DRAFT_CREATE_OPERATION = "email.draft.create";
export const EMAIL_SEND_OPERATION = "email.send";

const addressSchema = z.object({ name: z.string().optional(), address: z.string() });

export const mailEnvelopeSchema = z.object({
  from: addressSchema.optional(),
  to: z.array(addressSchema).default([]),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
});

export type MailEnvelope = z.infer<typeof mailEnvelopeSchema>;

export const messageEnvelopeSchema = z.object({
  envelope: mailEnvelopeSchema,
  /** The alias this message was actually delivered to, resolved once at ingest (mail/deliveredTo.ts). */
  deliveredToAddress: z.string().nullable().default(null),
  messageId: z.string().nullable().default(null),
  inReplyTo: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
});

export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;

/**
 * What a reply is built from when the module has no envelope to give: a message ingested
 * before the metadata existed, or one whose legacy migration could only reconstruct part of it
 * (`migrationStatus: 'partial'`, issue #93). The derived display text is all that is left, so
 * a reply still addresses the sender and a reply-all still reaches the visible To — it just
 * cannot invent the Cc that was never recorded.
 */
export function envelopeFromProperties(message: Item): MessageEnvelope {
  const sender = typeof message.properties.sender === "string" ? message.properties.sender : "";
  const recipients = typeof message.properties.recipients === "string" ? message.properties.recipients : "";
  const from = parseAddress(sender);
  return {
    envelope: { ...(from ? { from } : {}), to: parseAddressList(recipients), cc: [], bcc: [] },
    deliveredToAddress: null,
    messageId: null,
    inReplyTo: null,
    references: [],
  };
}

/**
 * The envelope a reply to this message is derived from. A failure here never breaks reading a
 * message or replying to it — it falls back to the display text — because the envelope is an
 * enrichment of data the item already carries, not a second source for it.
 */
export async function loadMessageEnvelope(operations: GenericOperations, databaseId: string, message: Item): Promise<MessageEnvelope> {
  try {
    return messageEnvelopeSchema.parse(await operations.callOperation(EMAIL_MESSAGE_ENVELOPE_OPERATION, { databaseId, itemId: message.id }));
  } catch {
    return envelopeFromProperties(message);
  }
}

export interface DraftPayload {
  mailboxItemId: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  bodyText: string;
  inReplyTo?: string | null;
  references?: string[];
}

const draftCreateResultSchema = z.object({ itemId: z.string() });

/** Creates the draft item; the module resolves the Emails database and the Drafts folder itself. */
export async function createDraft(operations: GenericOperations, payload: DraftPayload): Promise<string> {
  try {
    const result = draftCreateResultSchema.parse(await operations.callOperation(EMAIL_DRAFT_CREATE_OPERATION, { ...payload }));
    return result.itemId;
  } catch (error) {
    throw toOperationError(error);
  }
}

const sendResultSchema = z.object({ itemId: z.string(), messageId: z.string() });

export type SendResult = z.infer<typeof sendResultSchema>;

/** Submits an already-created draft. A rejected send throws; the draft it names stays a draft. */
export async function sendDraft(operations: GenericOperations, draftItemId: string, payload: DraftPayload): Promise<SendResult> {
  try {
    return sendResultSchema.parse(await operations.callOperation(EMAIL_SEND_OPERATION, { ...payload, draftItemId }));
  } catch (error) {
    throw toOperationError(error);
  }
}
