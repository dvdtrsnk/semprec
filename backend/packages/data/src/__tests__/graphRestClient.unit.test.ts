import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphRestClient, toFetchedGraphMessage } from "../mail/graphRestClient.js";

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
