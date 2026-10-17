import type { Transporter } from "nodemailer";

export interface SendInviteEmailInput {
  to: string;
  inviteUrl: string;
  /** ISO timestamp the invitation's link stops working at. */
  expiresAt: string;
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
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.transporter.sendMail({
          from: this.fromAddress,
          to: input.to,
          subject: "You have been invited to Semprec",
          text: `You have been invited to Semprec. Open this link to create your account:\n\n${input.inviteUrl}\n\nThis link expires in 7 days and can only be used once.`,
          html: `<p>You have been invited to Semprec. Open the link below to create your account. This link expires in 7 days and can only be used once.</p><p><a href="${escapeHtml(input.inviteUrl)}">${escapeHtml(input.inviteUrl)}</a></p>`,
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
