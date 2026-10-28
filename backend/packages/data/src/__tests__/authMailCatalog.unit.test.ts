import { describe, expect, it, vi } from "vitest";
import { NodemailerPasswordResetMailer } from "../auth/passwordResetMail.js";
import { NodemailerInviteMailer } from "../tenancy/inviteMail.js";
import { renderAuthMail } from "../auth/authMailCatalog.js";

const URL_WITH_SPECIALS = 'https://app.example.test/?page=x&a="b"<c>#token=abc';
const ESCAPED_URL = "https://app.example.test/?page=x&amp;a=&quot;b&quot;&lt;c&gt;#token=abc";
const PLAIN_URL = "https://app.example.test/?page=x#token=abc";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sender() {
  const sendMail = vi.fn().mockResolvedValue(undefined);
  return { sendMail, transporter: { sendMail } };
}

async function sentByReset(locale: string, resetUrl = PLAIN_URL) {
  const { sendMail, transporter } = sender();
  await new NodemailerPasswordResetMailer(transporter, "from@example.test").sendPasswordResetEmail({
    to: "to@example.test",
    resetUrl,
    locale,
  });
  return sendMail.mock.calls[0]![0] as { subject: string; text: string; html: string };
}

async function sentByInvite(locale: string, inviteUrl = PLAIN_URL) {
  const { sendMail, transporter } = sender();
  await new NodemailerInviteMailer(transporter, "from@example.test").sendInviteEmail({
    to: "to@example.test",
    inviteUrl,
    expiresAt: "2026-01-01T00:00:00.000Z",
    locale,
  });
  return sendMail.mock.calls[0]![0] as { subject: string; text: string; html: string };
}

describe("auth mail catalog (issue #1356)", () => {
  it("renders the English password-reset email with today's wording and the URL once per body", async () => {
    const mail = await sentByReset("en");
    expect(mail.subject).toBe("Reset your password");
    expect(mail.text).toBe(
      `Use this link to reset your password:\n\n${PLAIN_URL}\n\nThis link expires in 30 minutes and can only be used once. If you didn't request this, you can safely ignore this email.`,
    );
    expect(mail.html).toBe(
      `<p>Use the link below to reset your password. This link expires in 30 minutes and can only be used once.</p><p><a href="${PLAIN_URL}">${PLAIN_URL}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
    );
  });

  it("renders the Czech password-reset email", async () => {
    const mail = await sentByReset("cs");
    expect(mail.subject).toBe("Obnovte si heslo");
    expect(mail.text).toContain("Heslo si obnovíte");
    expect(mail.html).toContain("Heslo si obnovíte");
    expect(count(mail.text, PLAIN_URL)).toBe(1);
    expect(count(mail.html, PLAIN_URL)).toBe(2);
  });

  it("renders the English invitation email with today's wording", async () => {
    const mail = await sentByInvite("en");
    expect(mail.subject).toBe("You have been invited to Semprec");
    expect(mail.text).toBe(
      `You have been invited to Semprec. Open this link to create your account:\n\n${PLAIN_URL}\n\nThis link expires in 7 days and can only be used once.`,
    );
    expect(mail.html).toBe(
      `<p>You have been invited to Semprec. Open the link below to create your account. This link expires in 7 days and can only be used once.</p><p><a href="${PLAIN_URL}">${PLAIN_URL}</a></p>`,
    );
  });

  it("renders the Czech invitation email", async () => {
    const mail = await sentByInvite("cs");
    expect(mail.subject).toBe("Byli jste pozváni do Semprecu");
    expect(mail.text).toContain("Účet si vytvoříte");
    expect(mail.html).toContain("Účet si vytvoříte");
    expect(count(mail.text, PLAIN_URL)).toBe(1);
    expect(count(mail.html, PLAIN_URL)).toBe(2);
  });

  it("HTML-escapes the URL in the html body of both emails and leaves the text body verbatim", async () => {
    for (const mail of [await sentByReset("cs", URL_WITH_SPECIALS), await sentByInvite("en", URL_WITH_SPECIALS)]) {
      expect(count(mail.html, ESCAPED_URL)).toBe(2);
      expect(mail.html).not.toContain(URL_WITH_SPECIALS);
      expect(count(mail.text, URL_WITH_SPECIALS)).toBe(1);
    }
  });

  it("falls back to English for an unknown locale", async () => {
    expect((await sentByReset("de")).subject).toBe("Reset your password");
    expect((await sentByInvite("")).subject).toBe("You have been invited to Semprec");
  });

  it("keeps $ sequences in the URL literal", async () => {
    const rendered = await renderAuthMail("invite", "en", "https://x.test/$&$1", (v) => v);
    expect(rendered.text).toContain("https://x.test/$&$1");
  });
});
