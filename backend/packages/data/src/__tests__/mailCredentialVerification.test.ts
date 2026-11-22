import { afterEach, describe, expect, it, vi } from "vitest";
import * as connections from "../mail/mailServerConnections.js";
import { verifyMailCredentials } from "../mail/mailCredentialVerification.js";
import { logger } from "../mail/logger.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "../mail/providerTypes.js";

const generic = {
  provider: "generic" as const,
  address: "user@example.test",
  username: "user@example.test",
  password: "SENTINEL-PASSWORD",
  imapHost: "imap.example.test",
  smtpHost: "smtp.example.test",
};

describe("verifyMailCredentials", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the ordered generic candidates and returns the first successful settings", async () => {
    const imap = vi
      .spyOn(connections, "verifyImapServerConnection")
      .mockResolvedValueOnce("unreachable")
      .mockResolvedValueOnce("success");
    const smtp = vi
      .spyOn(connections, "verifySmtpServerConnection")
      .mockResolvedValueOnce("unreachable")
      .mockResolvedValueOnce("success");
    await expect(verifyMailCredentials(generic)).resolves.toEqual({
      imap: { host: generic.imapHost, port: 143, security: "starttls" },
      smtp: { host: generic.smtpHost, port: 587, security: "starttls" },
      folders: null,
    });
    expect(imap.mock.calls.map(([settings]) => settings.endpoint)).toEqual([
      { host: generic.imapHost, port: 993, security: "tls" },
      { host: generic.imapHost, port: 143, security: "starttls" },
    ]);
    expect(smtp.mock.calls.map(([settings]) => settings.endpoint)).toEqual([
      { host: generic.smtpHost, port: 465, security: "tls" },
      { host: generic.smtpHost, port: 587, security: "starttls" },
    ]);
  });

  it("returns the folders listed on the IMAP connection whose login succeeded when asked", async () => {
    const folders = [{ path: "INBOX" }, { path: "Drafts", specialUse: "\\Drafts" }];
    const plain = vi.spyOn(connections, "verifyImapServerConnection");
    const listing = vi
      .spyOn(connections, "verifyImapServerConnectionAndListFolders")
      .mockResolvedValueOnce({ attempt: "unreachable", folders: null })
      .mockResolvedValueOnce({ attempt: "success", folders });
    vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
    await expect(verifyMailCredentials({ ...generic, listFolders: true })).resolves.toEqual({
      imap: { host: generic.imapHost, port: 143, security: "starttls" },
      smtp: { host: generic.smtpHost, port: 465, security: "tls" },
      folders,
    });
    expect(listing.mock.calls.map(([settings]) => settings.endpoint)).toEqual([
      { host: generic.imapHost, port: 993, security: "tls" },
      { host: generic.imapHost, port: 143, security: "starttls" },
    ]);
    expect(plain).not.toHaveBeenCalled();
  });

  it("uses fixed iCloud endpoints", async () => {
    const imap = vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue("success");
    const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
    await expect(verifyMailCredentials({ ...generic, provider: "icloud" })).resolves.toEqual({
      imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
      folders: null,
    });
    expect(imap).toHaveBeenCalledTimes(1);
    expect(smtp).toHaveBeenCalledTimes(1);
  });

  it.each([
    { first: "authentication", second: "tls", expected: MailAuthFailedError },
    { first: "unreachable", second: "tls", expected: MailTlsFailedError },
    { first: "unreachable", second: "unreachable", expected: MailServerUnreachableError },
  ] as const)("prioritizes $first then $second when IMAP candidates fail", async ({ first, second, expected }) => {
    vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    // SMTP is verified concurrently; its own refusal (a different code for two of the rows) is not the one reported.
    const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("authentication");
    await expect(verifyMailCredentials(generic)).rejects.toBeInstanceOf(expected);
    expect(smtp.mock.calls.map(([settings]) => settings.endpoint)).toEqual([
      { host: generic.smtpHost, port: 465, security: "tls" },
      { host: generic.smtpHost, port: 587, security: "starttls" },
    ]);
  });

  it("maps iCloud authentication refusal to the app-password error", async () => {
    vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue("authentication");
    vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
    await expect(verifyMailCredentials({ ...generic, provider: "icloud" })).rejects.toBeInstanceOf(
      MailAppPasswordRequiredError,
    );
  });

  it.each([
    { first: "tls", second: "authentication", expected: MailAuthFailedError },
    { first: "tls", second: "unreachable", expected: MailTlsFailedError },
    { first: "unreachable", second: "unreachable", expected: MailServerUnreachableError },
  ] as const)("prioritizes $first then $second when SMTP candidates fail", async ({ first, second, expected }) => {
    vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue("success");
    vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(verifyMailCredentials(generic)).rejects.toBeInstanceOf(expected);
  });

  it("maps iCloud SMTP authentication refusal to the app-password error", async () => {
    vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue("success");
    vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("authentication");
    await expect(verifyMailCredentials({ ...generic, provider: "icloud" })).rejects.toBeInstanceOf(
      MailAppPasswordRequiredError,
    );
  });

  it("refuses generic settings without both hosts before connecting", async () => {
    const imap = vi.spyOn(connections, "verifyImapServerConnection");
    const smtp = vi.spyOn(connections, "verifySmtpServerConnection");
    await expect(
      verifyMailCredentials({
        provider: "generic",
        address: generic.address,
        username: generic.username,
        password: generic.password,
        imapHost: generic.imapHost,
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(imap).not.toHaveBeenCalled();
    expect(smtp).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["object", { password: generic.password }],
    ["nested aggregate", new AggregateError([new Error(generic.password), undefined], generic.password)],
  ])("terminates safely for an unknown %s rejection without trying another candidate", async (_name, rejection) => {
    const imap = vi.spyOn(connections, "verifyImapServerConnection").mockRejectedValue(rejection);
    let releaseSmtp: (attempt: "success") => void = () => undefined;
    const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSmtp = resolve;
      }),
    );
    let settled = false;
    const pending = verifyMailCredentials(generic).then(
      () => null,
      (error: unknown) => error,
    );
    void pending.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(imap).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    // The concurrent SMTP verification settles before the failure is answered, so it leaves nothing open.
    expect(settled).toBe(false);
    releaseSmtp("success");
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Missing verification failure");
    expect(outcome.message).toBe("Mail credential verification failed unexpectedly");
    expect(outcome).not.toHaveProperty("cause");
    expect(outcome).not.toBeInstanceOf(AggregateError);
    expect(JSON.stringify(outcome)).not.toContain(generic.password);
    expect(imap).toHaveBeenCalledTimes(1);
    // SMTP tried its candidates once, independently; its success does not turn the IMAP failure into a result.
    expect(smtp).toHaveBeenCalledTimes(1);
  });

  it("returns the fixed safe failure when diagnostic emission throws", async () => {
    const original = new Error(generic.password);
    const imap = vi.spyOn(connections, "verifyImapServerConnection").mockRejectedValue(original);
    vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
    vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error(generic.password);
    });
    const outcome = await verifyMailCredentials(generic).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Missing verification failure");
    expect(outcome.message).toBe("Mail credential verification failed unexpectedly");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain(generic.password);
    expect(imap).toHaveBeenCalledTimes(1);
  });

  it("does not expose an unknown helper failure or its credential-bearing message", async () => {
    vi.spyOn(connections, "verifyImapServerConnection").mockRejectedValue(new Error(generic.password));
    vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
    let error: unknown;
    try {
      await verifyMailCredentials(generic);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Missing verification failure");
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain(generic.password);
    expect(error).not.toBeInstanceOf(MailAuthFailedError);
  });
});
