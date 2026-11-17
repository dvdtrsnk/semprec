import type { Transporter } from "nodemailer";
import { renderAuthMail } from "./authMailCatalog.js";

export interface SendPasswordResetEmailInput {
  to: string;
  resetUrl: string;
  /** An unknown value renders English. */
  locale: string;
}

export interface PasswordResetMailer {
  sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void>;
}

/** Fails loudly rather than pretending to have sent mail when no SMTP is wired up. */
export const noopPasswordResetMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {
    throw new Error("No password-reset mailer configured for this composition root");
  },
};

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/** Defense in depth: today's URLs are safe, but a differently built `resetUrl` must not inject HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends with the application's own SMTP credentials, deliberately not via `sendDraftEmail`, which
 * needs an owning Mailbox item and Sent folder. `timeoutMs` bounds an unresponsive SMTP server.
 */
export class NodemailerPasswordResetMailer implements PasswordResetMailer {
  constructor(
    private readonly transporter: Pick<Transporter, "sendMail">,
    private readonly fromAddress: string,
    private readonly timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  ) {}

  async sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void> {
    const mail = await renderAuthMail("passwordReset", input.locale, input.resetUrl, escapeHtml);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.transporter.sendMail({
          from: this.fromAddress,
          to: input.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Password-reset email send timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
