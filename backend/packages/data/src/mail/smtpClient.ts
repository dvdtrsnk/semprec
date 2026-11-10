import type { MailSmtpTransporter } from "./mailServerConnections.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import { MailRecipientRejectedError, MailServerUnreachableError } from "./providerTypes.js";

function formatAddressHeader(address: MailEnvelopeAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export interface OutgoingMailMessage {
  from: MailEnvelopeAddress;
  to: MailEnvelopeAddress[];
  cc?: MailEnvelopeAddress[];
  bcc?: MailEnvelopeAddress[];
  subject: string;
  text?: string;
  html?: string;
  /** Set as the actual outgoing Message-ID header — must match what mail/send.ts stores in mail_message_meta so the later synced copy dedups onto the same item. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

/** The SMTP envelope of a raw message: the MAIL FROM address and every RCPT TO address, bcc included. */
export interface RawMailEnvelope {
  from: string;
  recipients: string[];
}

/** A complete RFC 5322 message, submitted byte for byte with its envelope (mail/outgoingMime.ts builds it). */
export interface RawMailMessage {
  raw: Buffer;
  envelope: RawMailEnvelope;
}

export interface MailSmtpClient {
  sendMail(message: OutgoingMailMessage): Promise<void>;
  sendRaw(message: RawMailMessage): Promise<void>;
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/**
 * Real `MailSmtpClient` (mail/mailTransport.ts) backed by `nodemailer`, over a transporter from
 * `createSmtpTransporter` (mail/mailServerConnections.ts), so every connection goes through the outbound
 * address policy. Building the transporter is a composition root's job, not this class's. `timeoutMs` is
 * enforced here regardless of whatever socket/connection timeout the transporter itself may or may not
 * have configured, so an unresponsive SMTP server can't hold a send open indefinitely. A timeout rejects
 * with `MailServerUnreachableError`, and a message the server accepts for only some recipients rejects
 * with `MailRecipientRejectedError`.
 */
export class NodemailerSmtpClient implements MailSmtpClient {
  constructor(
    private readonly transporter: Pick<MailSmtpTransporter, "sendMail">,
    private readonly timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  ) {}

  async sendMail(message: OutgoingMailMessage): Promise<void> {
    await this.deliver(
      this.transporter.sendMail({
        from: formatAddressHeader(message.from),
        to: message.to.map(formatAddressHeader),
        cc: message.cc?.map(formatAddressHeader),
        bcc: message.bcc?.map(formatAddressHeader),
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
        references: message.references,
      }),
    );
  }

  async sendRaw(message: RawMailMessage): Promise<void> {
    await this.deliver(
      this.transporter.sendMail({
        raw: message.raw,
        envelope: { from: message.envelope.from, to: message.envelope.recipients },
      }),
    );
  }

  /** Races one send against `timeoutMs`, then reports a refused recipient as an error. */
  private async deliver(send: Promise<{ refusedRecipientCount: number }>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        send,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MailServerUnreachableError()), this.timeoutMs);
        }),
      ]);
      if (result.refusedRecipientCount > 0) throw new MailRecipientRejectedError();
    } finally {
      clearTimeout(timer);
    }
  }
}
