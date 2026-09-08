import type { Transporter } from "nodemailer";

export interface SendPasswordResetEmailInput {
  to: string;
  resetUrl: string;
}

export interface PasswordResetMailer {
  sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void>;
}

/**
 * Default for a composition root that hasn't wired up SMTP yet — mirrors `noopMailSendAdapterFactory`
 * (mail/send.ts): fail loudly if `requestPasswordReset` is ever reached without a real mailer,
 * rather than silently pretending to have sent an email.
 */
export const noopPasswordResetMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {
    throw new Error("No password-reset mailer configured for this composition root");
  },
};

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/**
 * Belt-and-suspenders HTML-escaping for `resetUrl` in the email body. Safe without this today —
 * the URL is always built by `buildPasswordResetUrl`'s `URL` class, whose token component is
 * base64url and can't contain `<`, `>`, or `"` — but escaping here means a future `PasswordResetMailer`
 * caller with a differently-built `resetUrl` can't produce a malformed or injectable email body.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The app's own transactional SMTP path (issue #142, reusing the SMTP infrastructure #27
 * introduced) — a plain `nodemailer` transporter authenticated with the application's own
 * mailbox credentials, not one of a user's connected `Mailboxes` items. Deliberately does not
 * go through `sendDraftEmail` (mail/send.ts): that path claims a specific Email/Mailbox item
 * and files the result into that mailbox's Sent folder, which has no meaning for a system
 * notification with no owning mailbox item. `timeoutMs` guards against an unresponsive SMTP
 * server holding `requestPasswordReset` open indefinitely, same as `NodemailerSmtpClient`
 * (mail/smtpClient.ts).
 */
export class NodemailerPasswordResetMailer implements PasswordResetMailer {
  constructor(
    private readonly transporter: Pick<Transporter, "sendMail">,
    private readonly fromAddress: string,
    private readonly timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  ) {}

  async sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.transporter.sendMail({
          from: this.fromAddress,
          to: input.to,
          subject: "Reset your password",
          text: `Use this link to reset your password:\n\n${input.resetUrl}\n\nThis link expires in 30 minutes and can only be used once. If you didn't request this, you can safely ignore this email.`,
          html: `<p>Use the link below to reset your password. This link expires in 30 minutes and can only be used once.</p><p><a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
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
