import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailRestClient } from "../mail/gmailRestClient.js";

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
