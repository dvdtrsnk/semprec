import type { Transporter } from "nodemailer";
import { renderAuthMail } from "../auth/authMailCatalog.js";

export interface SendInviteEmailInput {
  to: string;
  inviteUrl: string;
  /** ISO timestamp the invitation's link stops working at. */
  expiresAt: string;
  /** Locale of the admin who created the invitation; an unknown value renders English. */
  locale: string;
}

export interface InviteMailer {
  sendInviteEmail(input: SendInviteEmailInput): Promise<void>;
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/** Same shape as `escapeHtml` in `auth/passwordResetMail.ts`: the invite URL is escaped before it reaches the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The app's transactional SMTP path for account invitations (issue #1040), built the way
 * `NodemailerPasswordResetMailer` is. `timeoutMs` keeps an unresponsive SMTP server from holding the
 * send open indefinitely.
 */
export class NodemailerInviteMailer implements InviteMailer {
  constructor(
    private readonly transporter: Pick<Transporter, "sendMail">,
    private readonly fromAddress: string,
    private readonly timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  ) {}

  async sendInviteEmail(input: SendInviteEmailInput): Promise<void> {
    const mail = await renderAuthMail("invite", input.locale, input.inviteUrl, escapeHtml);
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
            () => reject(new Error(`Invite email send timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
