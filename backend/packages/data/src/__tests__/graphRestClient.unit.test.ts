import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphRestClient, toFetchedGraphMessage } from "../mail/graphRestClient.js";
import { MailReauthorizationRequiredError, MailRecipientRejectedError } from "../mail/providerTypes.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Graph flag write-back", () => {
  it("patches the message resource with the requested flag state", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GraphRestClient(async () => "test-token");

    await client.patchMessage("message/1", { flag: { flagStatus: "flagged" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me/messages/message%2F1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ flag: { flagStatus: "flagged" } }) }),
    );
  });

  it("leaves flags undefined for an old delta link that omits isRead", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            value: [{ id: "message-1", internetMessageId: "<message-1@example.com>", flag: { flagStatus: "flagged" } }],
            "@odata.deltaLink": "https://graph.example/delta-next",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GraphRestClient(async () => "test-token");

    const delta = await client.fetchDelta("https://graph.example/old-delta");

    expect(delta.changes).toHaveLength(1);
    const [change] = delta.changes;
    if (!change || change.removed) throw new Error("Expected an active Graph message change");
    if (!change.message) throw new Error("Expected the active Graph message change to include a message payload");
    expect(change).toMatchObject({ id: "message-1", removed: false });
    expect(change.message.flags).toBeUndefined();
  });
});

describe("Graph bulk-mail headers (issue #1502)", () => {
  it("captures the four raw headers from internetMessageHeaders and null when absent", async () => {
    const message = await toFetchedGraphMessage(
      {
        id: "message-1",
        internetMessageHeaders: [
          { name: "List-Id", value: "<list.example.test>" },
          { name: "Auto-Submitted", value: "auto-generated" },
        ],
      },
      async () => [],
      async () => Readable.from(""),
    );
    expect(message.bulkHeaders).toEqual({
      listUnsubscribe: null,
      listId: "<list.example.test>",
      precedence: null,
      autoSubmitted: "auto-generated",
    });
  });
});

describe("Graph non-file attachments (issue #203)", () => {
  it("streams file attachments while appending item/reference annotations in deterministic safe order", async () => {
    const message = await toFetchedGraphMessage(
      {
        id: "message-1",
        hasAttachments: true,
        body: { contentType: "html", content: "<p>Message</p>" },
      },
      async () => [
        { "@odata.type": "#microsoft.graph.referenceAttachment", id: "ref-2", name: "zeta link" },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "file-1", name: "report.pdf" },
        {
          "@odata.type": "#microsoft.graph.itemAttachment",
          id: "item-2",
          name: "second\nitem\u0085\u2028line\u2029paragraph",
        },
        { "@odata.type": "#microsoft.graph.itemAttachment", id: "item-1", name: "<first>" },
        { "@odata.type": "#microsoft.graph.referenceAttachment", id: "ref-1" },
        { "@odata.type": "#microsoft.graph.unknownAttachment", id: "unknown", name: "ignored" },
      ],
      async (_messageId, attachmentId) => Readable.from(`bytes:${attachmentId}`),
    );

    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments[0];
    if (!attachment) throw new Error("Expected Graph file attachment");
    expect(attachment).toMatchObject({ filename: "report.pdf", disposition: "attachment" });
    expect(await attachment.openStream()).toBeInstanceOf(Readable);
    expect(message.bodyHtml).toBe(
      "<p>Message</p><p>[itemAttachment: &lt;first&gt;]</p><p>[itemAttachment: second item line paragraph]</p><p>[referenceAttachment: attachment]</p><p>[referenceAttachment: zeta link]</p>",
    );
  });

  it("adds annotations to plain text when an attachment name is missing", async () => {
    const message = await toFetchedGraphMessage(
      { id: "message-2", hasAttachments: true, body: { contentType: "text", content: "Message" } },
      async () => [{ "@odata.type": "#microsoft.graph.itemAttachment", id: "item-1" }],
      async () => Readable.from([]),
    );

    expect(message.bodyText).toBe("Message\n\n[itemAttachment: attachment]");
    expect(message.bodyHtml).toBeUndefined();
  });

  it("retains annotations when Graph provides an empty HTML body", async () => {
    const message = await toFetchedGraphMessage(
      { id: "message-3", hasAttachments: true, body: { contentType: "html", content: "" } },
      async () => [{ "@odata.type": "#microsoft.graph.referenceAttachment", id: "reference-1", name: "link" }],
      async () => Readable.from([]),
    );

    expect(message.bodyHtml).toBe("<p>[referenceAttachment: link]</p>");
  });
});

describe("Graph Reply-To envelope", () => {
  const noAttachments = async () => [];
  const noStream = async () => Readable.from("");

  it("stores the replyTo recipients", async () => {
    const message = await toFetchedGraphMessage(
      {
        id: "message-1",
        replyTo: [{ emailAddress: { name: "Support", address: "support@example.test" } }],
      },
      noAttachments,
      noStream,
    );
    expect(message.envelope.replyTo).toEqual([{ name: "Support", address: "support@example.test" }]);
  });

  it("leaves replyTo absent when Graph returns none", async () => {
    const message = await toFetchedGraphMessage({ id: "message-1", replyTo: [] }, noAttachments, noStream);
    expect(message.envelope).not.toHaveProperty("replyTo");
  });
});

const GRAPH_TOKEN = "graph-test-access-token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";

function graphClient(fetchImpl: typeof fetch): GraphRestClient {
  return new GraphRestClient(async () => GRAPH_TOKEN, fetchImpl);
}

/** The error a rejected call produced; fails the test when the call resolves instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (error: unknown) => error,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

const sampleDraft = {
  subject: "Hello",
  body: { contentType: "text" as const, content: "The body." },
  toRecipients: [{ emailAddress: { address: "bob@graph.test" } }],
  ccRecipients: [],
  bccRecipients: [{ emailAddress: { address: "dana@graph.test" } }],
  internetMessageId: "<sent-1@graph.test>",
  internetMessageHeaders: [{ name: "In-Reply-To", value: "<parent-1@graph.test>" }],
};

describe("Graph mail send (issue #1753)", () => {
  it("posts the MIME to sendMail as base64 text with the bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const raw = Buffer.from("From: me@graph.test\r\nMessage-ID: <sent-1@graph.test>\r\n\r\nHi\r\n");

    await graphClient(fetchMock).sendMime(raw);

    expect(fetchMock).toHaveBeenCalledWith(
      `${GRAPH_BASE}/sendMail`,
      expect.objectContaining({
        method: "POST",
        body: raw.toString("base64"),
        headers: { Authorization: `Bearer ${GRAPH_TOKEN}`, "Content-Type": "text/plain" },
      }),
    );
  });

  it("maps a refused recipient to MailRecipientRejectedError without naming the address", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "ErrorInvalidRecipients", message: "Invalid recipient nobody@graph.test" } },
        { status: 400 },
      ),
    );

    const error = await rejectionOf(graphClient(fetchMock).sendMime(Buffer.from("x")));

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect(messageOf(error)).not.toContain("nobody@graph.test");
  });

  it("maps a 400 that names no recipient to MailReauthorizationRequiredError", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "BadRequest" } }, { status: 400 }),
    );

    const error = await rejectionOf(graphClient(fetchMock).sendMime(Buffer.from("x")));

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
  });

  it("maps a 401 to MailReauthorizationRequiredError without naming the token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 }),
    );

    const error = await rejectionOf(graphClient(fetchMock).sendMime(Buffer.from("x")));

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect(messageOf(error)).not.toContain(GRAPH_TOKEN);
  });

  it("leaves any other failure as an ordinary error, neither reauthorization nor recipient", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));

    const error = await rejectionOf(graphClient(fetchMock).sendMime(Buffer.from("x")));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error).not.toBeInstanceOf(MailRecipientRejectedError);
    expect(messageOf(error)).toBe("Microsoft Graph request failed with status 503");
  });

  it("creates the draft with the Message-ID and reply headers and returns its id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "draft-1" }, { status: 201 }));

    const draft = await graphClient(fetchMock).createDraft(sampleDraft);

    expect(draft).toEqual({ id: "draft-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${GRAPH_BASE}/messages`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: `Bearer ${GRAPH_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(sampleDraft),
      }),
    );
  });

  it("refuses a draft response over the cap instead of parsing it short", async () => {
    // 33 MiB of body, past the 32 MiB cap on a create response.
    const megabyte = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 33; i += 1) controller.enqueue(megabyte);
        controller.close();
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { status: 201 }));

    const error = await rejectionOf(graphClient(fetchMock).createDraft(sampleDraft));

    expect(messageOf(error)).toMatch(/Microsoft Graph draft response is over the \d+-byte cap/);
  });

  it("refuses a draft response that is not JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("not json", { status: 201 }));

    const error = await rejectionOf(graphClient(fetchMock).createDraft(sampleDraft));

    expect(messageOf(error)).toBe("Microsoft Graph draft response is not valid JSON");
  });

  it("refuses a draft response with no body at all", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));

    const error = await rejectionOf(graphClient(fetchMock).createDraft(sampleDraft));

    expect(messageOf(error)).toBe("Microsoft Graph draft response is not valid JSON");
  });

  it.each([{}, { id: "" }])("refuses a draft response with no message id: %j", async (body) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body, { status: 201 }));

    const error = await rejectionOf(graphClient(fetchMock).createDraft(sampleDraft));

    expect(messageOf(error)).toBe("Microsoft Graph draft response has no message id");
  });

  it("opens an upload session for one attachment and leaves contentId out when there is none", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ uploadUrl: "https://upload.graph.test/session-1" }, { status: 201 }),
    );

    const session = await graphClient(fetchMock).createUploadSession("draft-1", {
      name: "report.pdf",
      contentType: "application/pdf",
      size: 12,
      isInline: false,
    });

    expect(session).toEqual({ uploadUrl: "https://upload.graph.test/session-1" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${GRAPH_BASE}/messages/draft-1/attachments/createUploadSession`);
    // An exact match also proves that no contentId was sent: a defined extra property would fail it.
    const body = init?.body;
    if (typeof body !== "string") throw new Error("the session request must carry a JSON string body");
    const sent: unknown = JSON.parse(body);
    expect(sent).toEqual({
      AttachmentItem: {
        attachmentType: "file",
        name: "report.pdf",
        size: 12,
        isInline: false,
        contentType: "application/pdf",
      },
    });
  });

  it.each(["http://upload.graph.test/session-1", "not a url"])(
    "refuses an upload URL that is not HTTPS, here %s",
    async (uploadUrl) => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ uploadUrl }, { status: 201 }));

      const error = await rejectionOf(
        graphClient(fetchMock).createUploadSession("draft-1", {
          name: "a.txt",
          contentType: "text/plain",
          size: 1,
          isInline: false,
        }),
      );

      expect(messageOf(error)).toBe("Microsoft Graph returned an upload URL that is not HTTPS");
    },
  );

  it("refuses an upload session response with no upload URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}, { status: 201 }));

    const error = await rejectionOf(
      graphClient(fetchMock).createUploadSession("draft-1", {
        name: "a.txt",
        contentType: "text/plain",
        size: 1,
        isInline: false,
      }),
    );

    expect(messageOf(error)).toBe("Microsoft Graph upload session response has no upload URL");
  });

  it("writes a chunk with its byte range to the upload URL, without the bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const chunk = Buffer.from([7, 8, 9]);

    await graphClient(fetchMock).uploadChunk("https://upload.graph.test/session-1", chunk, 3, 6);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://upload.graph.test/session-1",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Range": "bytes 3-5/6" },
        body: chunk,
      }),
    );
  });

  it("treats a refused chunk as an ordinary failure, never as a reauthorization", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("bad range", { status: 400 }));

    const error = await rejectionOf(
      graphClient(fetchMock).uploadChunk("https://upload.graph.test/session-1", Buffer.from([1]), 0, 1),
    );

    expect(error).not.toBeInstanceOf(MailReauthorizationRequiredError);
    expect(messageOf(error)).toBe("Microsoft Graph upload failed with status 400");
  });

  it("sends a draft with a bearer-authenticated POST to its send action", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));

    await graphClient(fetchMock).sendDraft("draft-1");

    expect(fetchMock).toHaveBeenCalledWith(
      `${GRAPH_BASE}/messages/draft-1/send`,
      expect.objectContaining({ method: "POST", headers: { Authorization: `Bearer ${GRAPH_TOKEN}` } }),
    );
  });

  it("deletes a message with a bearer-authenticated DELETE", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await graphClient(fetchMock).deleteMessage("draft-1");

    expect(fetchMock).toHaveBeenCalledWith(
      `${GRAPH_BASE}/messages/draft-1`,
      expect.objectContaining({ method: "DELETE", headers: { Authorization: `Bearer ${GRAPH_TOKEN}` } }),
    );
  });
});
