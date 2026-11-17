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
  /** Must match what send.ts stores in `mail_message_meta`, so the synced copy dedups onto the same item. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

/** bcc included in the RCPT TO addresses. */
export interface RawMailEnvelope {
  from: string;
  recipients: string[];
}

/** Submitted byte for byte with its envelope. */
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
 * Uses a policy-checked transporter built by the composition root. `timeoutMs` is enforced here whatever
 * the transporter's own timeouts, so an unresponsive server cannot hold a send open; a timeout rejects
 * with `MailServerUnreachableError`, a partial acceptance with `MailRecipientRejectedError`.
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
