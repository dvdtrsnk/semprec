import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { toFetchedGraphMessage } from "../mail/graphRestClient.js";

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
