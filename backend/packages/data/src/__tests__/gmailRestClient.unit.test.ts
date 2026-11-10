import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailRestClient } from "../mail/gmailRestClient.js";
import { logger } from "../mail/logger.js";

describe("Gmail sync provider privacy", () => {
  it.each([
    ["undefined", undefined],
    ["object", { token: "GMAIL-PRIVATE-SENTINEL" }],
    ["aggregate", new AggregateError([new Error("GMAIL-PRIVATE-SENTINEL")], "GMAIL-PRIVATE-SENTINEL")],
  ])("sanitizes an unknown %s fetch failure", async (_name, original) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(original);
    const client = new GmailRestClient(async () => "GMAIL-PRIVATE-SENTINEL", fetchImpl);
    const error = await client.getCurrentHistoryId().then(
      () => null,
      (value: unknown) => value,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Missing Gmail failure");
    expect(error.message).toBe("Gmail sync provider request failed unexpectedly");
    expect(error).not.toHaveProperty("cause");
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain("GMAIL-PRIVATE-SENTINEL");
  });

  it("sanitizes a body-read rejection and leaves token acquisition failures untouched", async () => {
    const original = new Error("GMAIL-PRIVATE-SENTINEL");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(original);
      },
    });
    const client = new GmailRestClient(
      async () => "GMAIL-PRIVATE-SENTINEL",
      async () => new Response(body),
    );
    const error = await client.getCurrentHistoryId().then(
      () => null,
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ message: "Gmail sync provider response could not be read" });
    expect(JSON.stringify(error)).not.toContain("GMAIL-PRIVATE-SENTINEL");
    const tokenError = new Error("token source identity");
    const fetchImpl = vi.fn<typeof fetch>();
    const rejected = new GmailRestClient(async () => {
      throw tokenError;
    }, fetchImpl);
    await expect(rejected.getCurrentHistoryId()).rejects.toBe(tokenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves a genuine 404 for missing messages and history invalidation", async () => {
    const client = new GmailRestClient(
      async () => "token",
      async () => new Response(null, { status: 404 }),
    );
    await expect(client.fetchMessage("missing")).resolves.toBeNull();
    await expect(client.listHistorySince("old")).resolves.toEqual({
      invalidated: true,
      newHistoryId: "old",
      changedMessageIds: [],
      removedMessageIds: [],
    });
  });
});

describe("Gmail label inventory validation", () => {
  it("accepts opaque user and system ids", async () => {
    const labels = [
      { id: "opaque", name: "Work", type: "user" },
      { id: "new-system", name: "Flag", type: "system" },
    ];
    const client = new GmailRestClient(
      async () => "token",
      async () => Response.json({ labels }),
    );
    expect(await client.listLabels()).toEqual(labels);
  });

  it.each([
    {},
    { labels: [{ id: "x", name: "X", type: "other" }] },
    {
      labels: [
        { id: "x", name: "X", type: "user" },
        { id: "x", name: "X", type: "system" },
      ],
    },
    { labels: [{ id: "", name: "X", type: "user" }] },
  ])("rejects an incomplete or ambiguous inventory", async (body) => {
    const client = new GmailRestClient(
      async () => "token",
      async () => Response.json(body),
    );
    await expect(client.listLabels()).rejects.toThrow();
  });
});
import { MailReauthorizationRequiredError, MailRecipientRejectedError } from "../mail/providerTypes.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function gmailMessage(payload: object): Response {
  return new Response(
    JSON.stringify({
      id: "gmail-message-1",
      threadId: "gmail-thread-1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Message-ID", value: "<gmail-message-1@example.test>" }],
        parts: [payload],
      },
    }),
    { status: 200 },
  );
}

it("sanitizes a lazy Gmail attachment request failure", async () => {
  const original = new Error("GMAIL-PRIVATE-SENTINEL");
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      gmailMessage({ mimeType: "application/pdf", filename: "x.pdf", body: { attachmentId: "a" } }),
    )
    .mockRejectedValueOnce(original);
  const client = new GmailRestClient(async () => "GMAIL-PRIVATE-SENTINEL", fetchImpl);
  const message = await client.fetchMessage("message");
  const attachment = message?.message.attachments[0];
  if (!attachment) throw new Error("Missing Gmail attachment");
  const error = await Promise.resolve(attachment.openStream()).then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toMatchObject({ message: "Gmail sync provider request failed unexpectedly" });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain("GMAIL-PRIVATE-SENTINEL");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

async function fetchFixture(payload: object) {
  const fetchMock = vi.fn(async () => gmailMessage(payload));
  vi.stubGlobal("fetch", fetchMock);
  const client = new GmailRestClient(async () => "test-token");
  const fetched = await client.fetchMessage("gmail-message-1");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetched;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gmail bulk-mail headers (issue #1502)", () => {
  it("captures the four raw headers from the payload and null when absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "gmail-message-1",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Message-ID", value: "<m@example.test>" },
                  { name: "List-Unsubscribe", value: "<mailto:u@example.test>" },
                  { name: "precedence", value: "bulk" },
                ],
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const fetched = await new GmailRestClient(async () => "t").fetchMessage("gmail-message-1");
    expect(fetched?.message.bulkHeaders).toEqual({
      listUnsubscribe: "<mailto:u@example.test>",
      listId: null,
      precedence: "bulk",
      autoSubmitted: null,
    });
  });
});

describe("Gmail Drive replacement attachments", () => {
  it("keeps Gmail's rendered HTML Drive link and label without creating an attachment candidate", async () => {
    const shareUrl = "https://drive.google.com/file/d/drive-file-1/view?usp=drive_link";
    const fetched = await fetchFixture({
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: encodeBase64Url(`<p><a href="${shareUrl}">Quarterly report</a></p>`) },
        },
        {
          mimeType: "application/pdf",
          filename: "Quarterly report.pdf",
          body: { size: 1, data: encodeBase64Url(shareUrl) },
        },
      ],
    });

    expect(fetched?.message.bodyHtml).toContain(">Quarterly report</a>");
    expect(fetched?.message.bodyHtml).toContain(shareUrl);
    expect(fetched?.message.attachments).toEqual([]);
  });

  it("recognizes the same tiny Drive replacement in a plain-text body", async () => {
    const shareUrl = "https://drive.google.com/file/d/drive-file-2/view?usp=sharing";
    const fetched = await fetchFixture({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: encodeBase64Url(`Download: ${shareUrl}`) } },
        {
          mimeType: "application/pdf",
          filename: "Plan.pdf",
          body: { size: 1, data: encodeBase64Url(shareUrl) },
        },
      ],
    });

    expect(fetched?.message.bodyText).toContain(shareUrl);
    expect(fetched?.message.attachments).toEqual([]);
  });

  it("recognizes a tiny Docs replacement the same way as a Drive one", async () => {
    const shareUrl = "https://docs.google.com/document/d/docs-file-1/edit?usp=sharing";
    const fetched = await fetchFixture({
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: encodeBase64Url(`<p><a href="${shareUrl}">Meeting notes</a></p>`) },
        },
        {
          mimeType: "application/pdf",
          filename: "Meeting notes.pdf",
          body: { size: 1, data: encodeBase64Url(shareUrl) },
        },
      ],
    });

    expect(fetched?.message.bodyHtml).toContain(">Meeting notes</a>");
    expect(fetched?.message.bodyHtml).toContain(shareUrl);
    expect(fetched?.message.attachments).toEqual([]);
  });

  it("does not turn ordinary Drive prose into an attachment decision", async () => {
    const shareUrl = "https://drive.google.com/file/d/drive-file-3/view?usp=sharing";
    const attachment = "a real PDF payload";
    const fetched = await fetchFixture({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: encodeBase64Url(`FYI: ${shareUrl}`) } },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { size: Buffer.byteLength(attachment), data: encodeBase64Url(attachment) },
        },
      ],
    });

    expect(fetched?.message.attachments).toHaveLength(1);
    expect(fetched?.message.attachments[0]).toMatchObject({ filename: "invoice.pdf", disposition: "attachment" });
  });

  it("requires a matching Drive shorthand URL, including its file id", async () => {
    const renderedUrl = "https://drive.google.com/open?id=rendered-file";
    const placeholderUrl = "https://drive.google.com/open?id=other-file";
    const fetched = await fetchFixture({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: encodeBase64Url(`FYI: ${renderedUrl}`) } },
        {
          mimeType: "application/pdf",
          filename: "different-file.pdf",
          body: { size: 1, data: encodeBase64Url(placeholderUrl) },
        },
      ],
    });

    expect(fetched?.message.attachments).toHaveLength(1);
    expect(fetched?.message.attachments[0]).toMatchObject({ filename: "different-file.pdf" });
  });

  it("keeps real attachments and continues to exclude CID rendering assets", async () => {
    const attachment = "a real PDF payload";
    const fetched = await fetchFixture({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: encodeBase64Url('<img src="cid:logo-1">') } },
        {
          mimeType: "image/png",
          filename: "logo.png",
          headers: [
            { name: "Content-Disposition", value: "inline" },
            { name: "Content-ID", value: "<logo-1>" },
          ],
          body: { size: 4, data: encodeBase64Url("logo") },
        },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { size: Buffer.byteLength(attachment), data: encodeBase64Url(attachment) },
        },
      ],
    });

    expect(fetched?.message.attachments).toHaveLength(1);
    expect(fetched?.message.attachments[0]).toMatchObject({ filename: "invoice.pdf", disposition: "attachment" });
  });
});

describe("Gmail flag write-back", () => {
  it("posts label additions and removals to users.messages.modify", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GmailRestClient(async () => "test-token");

    await client.modifyMessageLabels("message/1", ["STARRED"], ["UNREAD"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/message%2F1/modify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] }),
      }),
    );
  });
});

describe("Gmail Reply-To envelope", () => {
  async function fetchWithHeaders(extra: { name: string; value: string }[]) {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "gmail-message-1",
            threadId: "gmail-thread-1",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Message-ID", value: "<gmail-message-1@example.test>" },
                { name: "From", value: "Sender <sender@example.test>" },
                { name: "To", value: "To Person <to@example.test>" },
                { name: "Cc", value: "Cc Person <cc@example.test>" },
                { name: "Bcc", value: "Bcc Person <bcc@example.test>" },
                ...extra,
              ],
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return new GmailRestClient(async () => "test-token").fetchMessage("gmail-message-1");
  }

  it("stores the Reply-To header addresses", async () => {
    const fetched = await fetchWithHeaders([
      { name: "Reply-To", value: "Support <support@example.test>, other@example.test" },
    ]);
    expect(fetched?.message.envelope.replyTo).toEqual([
      { name: "Support", address: "support@example.test" },
      { name: undefined, address: "other@example.test" },
    ]);
  });

  it("leaves replyTo absent when the header has no parseable address", async () => {
    const fetched = await fetchWithHeaders([{ name: "Reply-To", value: "<>" }]);
    expect(fetched?.message.envelope).toEqual({
      from: { name: "Sender", address: "sender@example.test" },
      to: [{ name: "To Person", address: "to@example.test" }],
      cc: [{ name: "Cc Person", address: "cc@example.test" }],
      bcc: [{ name: "Bcc Person", address: "bcc@example.test" }],
    });
  });

  it("leaves replyTo absent without a Reply-To header", async () => {
    const fetched = await fetchWithHeaders([]);
    expect(fetched?.message.envelope).toEqual({
      from: { name: "Sender", address: "sender@example.test" },
      to: [{ name: "To Person", address: "to@example.test" }],
      cc: [{ name: "Cc Person", address: "cc@example.test" }],
      bcc: [{ name: "Bcc Person", address: "bcc@example.test" }],
    });
  });
});

describe("Gmail sendMessage (issue #1637)", () => {
  const RAW_MESSAGE = Buffer.from("Message-ID: <sent-1@example.test>\r\nSubject: Hi\r\n\r\nbody\r\n");
  const SECRET_TOKEN = "secret-access-token-value";

  function sendResponse(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }

  function stubSend(response: Response) {
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    return { fetchMock, client: new GmailRestClient(async () => SECRET_TOKEN, fetchMock) };
  }

  /** The URL, init and string body of the request the mock recorded at `index`. */
  function sentRequest(
    fetchMock: { mock: { calls: unknown[][] } },
    index = 0,
  ): { url: string; init: RequestInit; body: string } {
    const call = fetchMock.mock.calls[index] as [string, RequestInit | undefined] | undefined;
    const init = call?.[1] ?? {};
    return { url: call?.[0] ?? "", init, body: typeof init.body === "string" ? init.body : "" };
  }

  it("posts the raw MIME base64url-encoded with the bearer token and returns the id and thread id", async () => {
    const { fetchMock, client } = stubSend(sendResponse(200, { id: "sent-id-1", threadId: "thread-1" }));

    const sent = await client.sendMessage(RAW_MESSAGE);

    expect(sent).toEqual({ id: "sent-id-1", threadId: "thread-1" });
    const { url, init, body: requestBody } = sentRequest(fetchMock);
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${SECRET_TOKEN}`, "Content-Type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body.raw).toBe(RAW_MESSAGE.toString("base64url"));
    expect(Buffer.from(String(body.raw), "base64url").equals(RAW_MESSAGE)).toBe(true);
  });

  it("omits threadId from the request when no thread is named", async () => {
    const { fetchMock, client } = stubSend(sendResponse(200, { id: "sent-id-1", threadId: "thread-new" }));

    await client.sendMessage(RAW_MESSAGE);

    expect(JSON.parse(sentRequest(fetchMock).body)).not.toHaveProperty("threadId");
  });

  it("sends the named threadId so a reply joins its Gmail conversation", async () => {
    const { fetchMock, client } = stubSend(sendResponse(200, { id: "sent-id-2", threadId: "thread-existing" }));

    const sent = await client.sendMessage(RAW_MESSAGE, "thread-existing");

    expect(JSON.parse(sentRequest(fetchMock).body)).toMatchObject({ threadId: "thread-existing" });
    expect(sent.threadId).toBe("thread-existing");
  });

  it("makes no Gmail request when the token source fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sendResponse(200, { id: "x", threadId: "y" }));
    const refusal = new MailReauthorizationRequiredError("token refresh refused");
    const client = new GmailRestClient(async () => {
      throw refusal;
    }, fetchMock);

    await expect(client.sendMessage(RAW_MESSAGE)).rejects.toBe(refusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 400 that names an invalid To header to MailRecipientRejectedError without its text", async () => {
    const { client } = stubSend(
      sendResponse(400, {
        error: {
          code: 400,
          message: "Invalid To header",
          errors: [{ message: "Invalid To header", reason: "invalidArgument" }],
          status: "INVALID_ARGUMENT",
        },
      }),
    );

    const error = await client.sendMessage(RAW_MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect((error as Error).message).not.toContain("Invalid To header");
  });

  it("maps a refusal that names an invalid recipient to MailRecipientRejectedError whatever its status", async () => {
    const { client } = stubSend(sendResponse(403, { error: { message: "Invalid recipient address" } }));

    await expect(client.sendMessage(RAW_MESSAGE)).rejects.toBeInstanceOf(MailRecipientRejectedError);
  });

  it("maps a 401 to MailReauthorizationRequiredError without the token", async () => {
    const { client } = stubSend(sendResponse(401, { error: { message: "Invalid Credentials" } }));

    const error = await client.sendMessage(RAW_MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect((error as Error).message).not.toContain(SECRET_TOKEN);
  });

  it("maps a 400 that names no recipient to MailReauthorizationRequiredError", async () => {
    const { client } = stubSend(sendResponse(400, { error: { message: "Bad Request" } }));

    await expect(client.sendMessage(RAW_MESSAGE)).rejects.toBeInstanceOf(MailReauthorizationRequiredError);
  });

  it("leaves any other status as an ordinary failure that names only the status", async () => {
    const { client } = stubSend(sendResponse(500, "upstream trace with a recipient secret@example.test"));

    const error = await client.sendMessage(RAW_MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error).not.toBeInstanceOf(MailRecipientRejectedError);
    expect((error as Error).message).toBe("Gmail send failed with status 500");
  });

  it.each([undefined, { token: "PRIVATE-SEND-SECRET" }, new Error("PRIVATE-SEND-SECRET")])(
    "confines an unknown send fetch rejection",
    async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
      const client = new GmailRestClient(async () => SECRET_TOKEN, fetchImpl);
      const error: unknown = await client.sendMessage(RAW_MESSAGE).then(
        () => null,
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected a failure");
      expect(error.message).toBe("Mail send provider operation failed");
      expect(error).not.toHaveProperty("cause");
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain("PRIVATE-SEND-SECRET");
    },
  );

  it("confines a failed required success body without fabricating an id", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("PRIVATE-SEND-SECRET"));
      },
    });
    const client = new GmailRestClient(
      async () => SECRET_TOKEN,
      async () => new Response(stream, { status: 200 }),
    );
    const error: unknown = await client.sendMessage(RAW_MESSAGE).then(
      () => null,
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ message: "Mail send provider operation failed" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE-SEND-SECRET");
  });

  it("confines an undefined reader failure even when cleanup diagnostics also fail", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("PRIVATE-DIAGNOSTIC");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(undefined);
      },
    });
    const client = new GmailRestClient(
      async () => SECRET_TOKEN,
      async () => new Response(body, { status: 200 }),
    );
    const error: unknown = await client.sendMessage(RAW_MESSAGE).then(
      () => null,
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ message: "Mail send provider operation failed" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
    expect(warn).toHaveBeenCalledWith({ stage: "send-response" }, "Mail send cleanup failed");
  });

  it("retains a genuine recipient refusal when reader cancellation and diagnostics fail", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("PRIVATE-DIAGNOSTIC");
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(`invalid recipient ${"x".repeat(5000)}`));
      },
      cancel() {
        throw new Error("PRIVATE-CLEANUP");
      },
    });
    const client = new GmailRestClient(
      async () => SECRET_TOKEN,
      async () => new Response(stream, { status: 400 }),
    );
    const error: unknown = await client.sendMessage(RAW_MESSAGE).then(
      () => null,
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
    expect(warn).toHaveBeenCalledWith({ stage: "send-response" }, "Mail send cleanup failed");
    expect(stream.locked).toBe(false);
  });

  it("rejects a success response that lacks the message or thread id", async () => {
    const { client } = stubSend(sendResponse(200, { id: "sent-id-only" }));

    await expect(client.sendMessage(RAW_MESSAGE)).rejects.toThrow(/missing the message id or the thread id/);
  });
});
