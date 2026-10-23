import type { Transporter } from "nodemailer";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

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

export interface MailSmtpClient {
  sendMail(message: OutgoingMailMessage): Promise<void>;
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/**
 * Real `MailSmtpClient` (mail/send.ts) backed by `nodemailer`. Like `ImapFlowMailClient`
 * (mail/imapFlowClient.ts), this wraps an already-authenticated transport — building the real
 * `nodemailer.createTransport(...)` call (OAuth2 token exchange vs. app-password, per
 * Mailboxes.provider) is a composition root's job, not this package's; no real composition
 * root that opens either kind of connection exists yet in this repo (see
 * imapFlowClient.ts's own header note). `timeoutMs` is enforced here regardless of whatever
 * socket/connection timeout the injected transporter itself may or may not have configured, so
 * an unresponsive SMTP server can't hold `sendDraftEmail` (mail/send.ts) open indefinitely.
 */
export class NodemailerSmtpClient implements MailSmtpClient {
  constructor(
    private readonly transporter: Pick<Transporter, "sendMail">,
    private readonly timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  ) {}

  async sendMail(message: OutgoingMailMessage): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
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
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`SMTP send timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
