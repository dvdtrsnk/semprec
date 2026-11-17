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

function sentMail(value: unknown): { subject: string; text: string; html: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("subject" in value) ||
    typeof value.subject !== "string" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !("html" in value) ||
    typeof value.html !== "string"
  )
    throw new Error("Expected a rendered auth email");
  return { subject: value.subject, text: value.text, html: value.html };
}

function expectOneAnchor(html: string, escapedUrl: string): void {
  const anchors = [...html.matchAll(/<a\b[^>]*>.*?<\/a>/g)];
  expect(anchors).toHaveLength(1);
  expect(anchors[0]?.[0]).toBe(`<a href="${escapedUrl}">${escapedUrl}</a>`);
}

async function sentByReset(locale: string, resetUrl = PLAIN_URL) {
  const { sendMail, transporter } = sender();
  await new NodemailerPasswordResetMailer(transporter, "from@example.test").sendPasswordResetEmail({
    to: "to@example.test",
    resetUrl,
    locale,
  });
  return sentMail(sendMail.mock.calls[0]?.[0]);
}

async function sentByInvite(locale: string, inviteUrl = PLAIN_URL) {
  const { sendMail, transporter } = sender();
  await new NodemailerInviteMailer(transporter, "from@example.test").sendInviteEmail({
    to: "to@example.test",
    inviteUrl,
    expiresAt: "2026-01-01T00:00:00.000Z",
    locale,
  });
  return sentMail(sendMail.mock.calls[0]?.[0]);
}

describe("auth mail catalog (issue #1356)", () => {
  it("retries catalog loading after a transient failure", async () => {
    const registry = await vi.importActual<typeof import("@semprec/module-registry")>("@semprec/module-registry");
    const load = vi.fn(registry.loadModuleCatalogs).mockRejectedValueOnce(new Error("catalog temporarily unavailable"));
    vi.doMock("@semprec/module-registry", () => ({ ...registry, loadModuleCatalogs: load }));
    vi.resetModules();
    try {
      const { renderAuthMail: freshRenderer } = await import("../auth/authMailCatalog.js");
      await expect(freshRenderer("invite", "en", PLAIN_URL, (value) => value)).rejects.toThrow(
        "catalog temporarily unavailable",
      );
      const rendered = await freshRenderer("invite", "en", PLAIN_URL, (value) => value);
      expect(rendered.subject).toBe("You have been invited to Semprec");
      expect(rendered.text).toContain(PLAIN_URL);
      await freshRenderer("passwordReset", "cs", PLAIN_URL, (value) => value);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("@semprec/module-registry");
      vi.resetModules();
    }
  });

  it("renders the English password-reset email with today's wording and one link", async () => {
    const mail = await sentByReset("en");
    expect(mail.subject).toBe("Reset your password");
    expect(mail.text).toBe(
      `Use this link to reset your password:\n\n${PLAIN_URL}\n\nThis link expires in 30 minutes and can only be used once. If you didn't request this, you can safely ignore this email.`,
    );
    expect(mail.html).toBe(
      `<p>Use the link below to reset your password. This link expires in 30 minutes and can only be used once.</p><p><a href="${PLAIN_URL}">${PLAIN_URL}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
    );
    expect(count(mail.text, PLAIN_URL)).toBe(1);
    expectOneAnchor(mail.html, PLAIN_URL);
  });

  it("renders the Czech password-reset email", async () => {
    const mail = await sentByReset("cs");
    expect(mail.subject).toBe("Obnovte si heslo");
    expect(mail.text).toContain("Heslo si obnovíte");
    expect(mail.html).toContain("Heslo si obnovíte");
    expect(count(mail.text, PLAIN_URL)).toBe(1);
    expect(count(mail.html, PLAIN_URL)).toBe(2);
    expectOneAnchor(mail.html, PLAIN_URL);
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
    expect(count(mail.text, PLAIN_URL)).toBe(1);
    expectOneAnchor(mail.html, PLAIN_URL);
  });

  it("renders the Czech invitation email", async () => {
    const mail = await sentByInvite("cs");
    expect(mail.subject).toBe("Byli jste pozváni do Semprecu");
    expect(mail.text).toContain("Účet si vytvoříte");
    expect(mail.html).toContain("Účet si vytvoříte");
    expect(count(mail.text, PLAIN_URL)).toBe(1);
    expect(count(mail.html, PLAIN_URL)).toBe(2);
    expectOneAnchor(mail.html, PLAIN_URL);
  });

  it("HTML-escapes the URL in the html body of both emails and leaves the text body verbatim", async () => {
    for (const mail of [await sentByReset("cs", URL_WITH_SPECIALS), await sentByInvite("en", URL_WITH_SPECIALS)]) {
      expect(count(mail.html, ESCAPED_URL)).toBe(2);
      expectOneAnchor(mail.html, ESCAPED_URL);
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
