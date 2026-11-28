import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OperationError } from "../../../api/genericOperations.js";
import {
  MAIL_CONTENT_UNAVAILABLE_REASONS,
  MailMessageError,
  type MailMessageAttachment,
  type MailMessageContent,
  type MailMessageOperations,
} from "../../../api/mailMessageOperations.js";
import { formatByteSize } from "../../../i18n/format.js";
import { createFakeOperations, type FakeBackend } from "../../../test/fakeOperations.js";
import { createFakeMailMessages, type FakeMailMessages } from "../../../test/fakeMailMessages.js";
import { createMailboxBackend } from "../../../test/mailboxFixture.js";
import { renderMailbox, setViewport } from "../../../test/renderMailbox.js";

const REPORT: MailMessageAttachment = {
  attachmentId: "attachment-report",
  filename: "report.pdf",
  contentType: "application/pdf",
  byteSize: 2048,
  stored: false,
  blobId: null,
  fileItemId: null,
};

const SCAN: MailMessageAttachment = {
  attachmentId: "attachment-scan",
  filename: "scan.png",
  contentType: "image/png",
  byteSize: 1_572_864,
  stored: true,
  blobId: "blob-scan",
  fileItemId: "file-scan",
};

/** Resolves or rejects a call the test holds open. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function messagePane(): HTMLElement {
  return screen.getByRole("region", { name: "Message" });
}

async function openInvoice(backend: FakeBackend, mailMessages: MailMessageOperations, locale: "cs" | "en" = "en") {
  renderMailbox(createFakeOperations(backend), { mailMessages, locale });
  const messages = await screen.findByRole("region", { name: locale === "en" ? "Messages" : "Zprávy" });
  await userEvent.click(await within(messages).findByRole("button", { name: /Invoice for March/ }));
}

describe("mailbox message content", () => {
  let backend: FakeBackend;
  let fake: FakeMailMessages;

  beforeEach(() => {
    setViewport(false);
    backend = createMailboxBackend();
    fake = createFakeMailMessages(backend, { "email-1": [{ ...SCAN }, { ...REPORT }] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a loading state while the content route answers, then the body as plain text", async () => {
    const answer = deferred<MailMessageContent>();
    let content: MailMessageContent | undefined;
    const mailMessages: MailMessageOperations = {
      ...fake,
      getContent: async (emailId) => {
        content = { ...(await fake.getContent(emailId)), bodyText: "<b>Paid</b> in full." };
        return answer.promise;
      },
    };

    await openInvoice(backend, mailMessages);

    expect(await within(messagePane()).findByRole("status")).toHaveTextContent("Loading the message…");
    // The envelope does not wait for the body.
    expect(within(messagePane()).getByRole("heading", { name: "Invoice for March" })).toBeInTheDocument();
    await waitFor(() => expect(content).toBeDefined());
    if (!content) throw new Error("The content route was not called");
    answer.resolve(content);

    // Text, never markup: the tags are shown as typed.
    expect(await within(messagePane()).findByText("<b>Paid</b> in full.")).toBeInTheDocument();
    expect(within(messagePane()).queryByRole("status")).toBeNull();
  });

  it("reads every message's body through the content route, stored bodies included", async () => {
    await openInvoice(backend, fake);

    expect(await within(messagePane()).findByText("Attached.")).toBeInTheDocument();
    expect(fake.calls).toEqual([{ kind: "getContent", emailId: "email-1" }]);
  });

  it("shows why a provider fetch failed and recovers on retry", async () => {
    let failNext = true;
    const mailMessages: MailMessageOperations = {
      ...fake,
      getContent: async (emailId) => {
        if (failNext) {
          failNext = false;
          throw new MailMessageError({ code: "contentUnavailable", reason: "providerUnreachable" }, 409);
        }
        return fake.getContent(emailId);
      },
    };

    await openInvoice(backend, mailMessages);

    const alert = await within(messagePane()).findByRole("alert");
    expect(alert).toHaveTextContent("The message could not be loaded");
    expect(alert).toHaveTextContent("The mail server could not be reached");
    // The envelope and the reply actions stay usable.
    expect(within(messagePane()).getByRole("button", { name: "Reply" })).toBeInTheDocument();

    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(messagePane()).findByText("Attached.")).toBeInTheDocument();
    expect(within(messagePane()).queryByRole("alert")).toBeNull();
  });

  const reasonTexts: Record<(typeof MAIL_CONTENT_UNAVAILABLE_REASONS)[number], string> = {
    reauthorizationRequired: "The mail account needs you to sign in again",
    providerUnreachable: "The mail server could not be reached",
    messageNotFound: "The mail server no longer holds this message",
    mailboxUnavailable: "The mail account was removed or has mail switched off",
    attachmentTooLarge: "The attachment is too large to save",
  };

  it.each([
    ...MAIL_CONTENT_UNAVAILABLE_REASONS.map((reason) => ({
      name: reason,
      error: new MailMessageError({ code: "contentUnavailable", reason }, 409),
      text: reasonTexts[reason],
      retry: true,
    })),
    {
      name: "rate limit",
      error: new MailMessageError({ code: "rateLimited", retryAfterSeconds: 30 }, 429),
      text: "Too much mail was downloaded in a short time; try again later",
      retry: true,
    },
    {
      name: "a gone message",
      error: new MailMessageError({ code: "notFound" }, 404),
      text: "This message no longer exists",
      retry: false,
    },
    {
      name: "another server failure",
      error: new OperationError("retryable", "Request failed", 500),
      text: "The server answered with status 500",
      retry: true,
    },
  ])("says what went wrong for $name", async ({ error, text, retry }) => {
    const mailMessages: MailMessageOperations = {
      ...fake,
      getContent: () => Promise.reject(error),
    };

    await openInvoice(backend, mailMessages);

    const alert = await within(messagePane()).findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(within(alert).queryByRole("button", { name: "Try again" }) !== null).toBe(retry);
  });

  it("says why in Czech when the mailbox is shown in Czech", async () => {
    const mailMessages: MailMessageOperations = {
      ...fake,
      getContent: () =>
        Promise.reject(new MailMessageError({ code: "contentUnavailable", reason: "reauthorizationRequired" }, 409)),
    };

    await openInvoice(backend, mailMessages, "cs");

    const alert = await within(screen.getByRole("region", { name: "Zpráva" })).findByRole("alert");
    expect(alert).toHaveTextContent("Zprávu se nepodařilo načíst");
    expect(alert).toHaveTextContent("Poštovní účet vyžaduje nové přihlášení");
    expect(within(alert).getByRole("button", { name: "Zkusit znovu" })).toBeInTheDocument();
  });

  it("lists the attachments with name, type and size, a stored one linking to its blob", async () => {
    await openInvoice(backend, fake);

    const list = await within(messagePane()).findByRole("list", { name: "Attachments" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [scan, report] = rows as [HTMLElement, HTMLElement];

    const link = within(scan).getByRole("link", { name: "scan.png" });
    expect(link).toHaveAttribute("href", "/api/blobs/blob-scan");
    expect(link).toHaveAttribute("target", "_blank");
    expect(scan).toHaveTextContent("image/png");
    expect(scan).toHaveTextContent(formatByteSize("en", SCAN.byteSize));
    expect(within(scan).queryByRole("button")).toBeNull();

    expect(within(report).queryByRole("link")).toBeNull();
    expect(report).toHaveTextContent("report.pdf");
    expect(report).toHaveTextContent("application/pdf");
    expect(report).toHaveTextContent(formatByteSize("en", REPORT.byteSize));
    expect(within(report).getByRole("button", { name: "Save to Files" })).toHaveAccessibleDescription("report.pdf");
  });

  it("saves an unstored attachment to Files, then shows it as stored from the refreshed content", async () => {
    const save = deferred<{ fileItemId: string }>();
    const mailMessages: MailMessageOperations = {
      ...fake,
      saveAttachment: async (emailId, attachmentId) => {
        await save.promise;
        return fake.saveAttachment(emailId, attachmentId);
      },
    };
    await openInvoice(backend, mailMessages);
    const list = await within(messagePane()).findByRole("list", { name: "Attachments" });

    await userEvent.click(within(list).getByRole("button", { name: "Save to Files" }));

    const saving = within(list).getByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    // The body stays on screen while the attachment is being saved.
    expect(within(messagePane()).getByText("Attached.")).toBeInTheDocument();
    save.resolve({ fileItemId: "ignored" });

    const link = await within(list).findByRole("link", { name: "report.pdf" });
    expect(link).toHaveAttribute("href", `/api/blobs/blob-${REPORT.attachmentId}`);
    expect(within(list).queryByRole("button")).toBeNull();
    expect(fake.calls).toEqual([
      { kind: "getContent", emailId: "email-1" },
      { kind: "saveAttachment", emailId: "email-1", attachmentId: REPORT.attachmentId },
      { kind: "getContent", emailId: "email-1" },
    ]);
  });

  it("keeps an attachment unsaved and says why when the save is refused, and lets it be tried again", async () => {
    let refuse = true;
    const mailMessages: MailMessageOperations = {
      ...fake,
      saveAttachment: async (emailId, attachmentId) => {
        if (refuse) {
          refuse = false;
          throw new MailMessageError({ code: "contentUnavailable", reason: "attachmentTooLarge" }, 409);
        }
        return fake.saveAttachment(emailId, attachmentId);
      },
    };
    await openInvoice(backend, mailMessages);
    const list = await within(messagePane()).findByRole("list", { name: "Attachments" });

    await userEvent.click(within(list).getByRole("button", { name: "Save to Files" }));

    expect(await within(list).findByRole("alert")).toHaveTextContent(
      "The attachment could not be saved: The attachment is too large to save",
    );
    expect(within(list).queryByRole("link", { name: "report.pdf" })).toBeNull();
    // No content re-read for a save that did not happen.
    expect(fake.calls.filter((call) => call.kind === "getContent")).toHaveLength(1);

    await userEvent.click(within(list).getByRole("button", { name: "Save to Files" }));
    expect(await within(list).findByRole("link", { name: "report.pdf" })).toBeInTheDocument();
    expect(within(list).queryByRole("alert")).toBeNull();
  });

  it("drops a slower answer for a message no longer open", async () => {
    const first = deferred<MailMessageContent>();
    const mailMessages: MailMessageOperations = {
      ...fake,
      getContent: (emailId) => (emailId === "email-1" ? first.promise : fake.getContent(emailId)),
    };
    await openInvoice(backend, mailMessages);
    const messages = screen.getByRole("region", { name: "Messages" });

    await userEvent.click(within(messages).getByRole("button", { name: /Lunch\?/ }));
    expect(await within(messagePane()).findByText("Thursday?")).toBeInTheDocument();
    first.resolve({ ...(await fake.getContent("email-1")), bodyText: "Stale invoice body" });

    await waitFor(() => expect(within(messagePane()).getByText("Thursday?")).toBeInTheDocument());
    expect(within(messagePane()).queryByText("Stale invoice body")).toBeNull();
  });
});
