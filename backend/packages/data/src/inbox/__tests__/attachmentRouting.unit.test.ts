import { describe, expect, it } from "vitest";
import { audioKindForDuration, type InboxAttachmentMetadata } from "../inboxAttachmentMetadata.js";
import { routeInboxAttachments } from "../attachmentRouting.js";

// Issue gh-1985: the decision of the Inbox tick, from an item's attachments alone.

function audio(attachmentId: string, metadata: InboxAttachmentMetadata | null, mimeType = "audio/mp4") {
  return { attachmentId, mimeType, metadata };
}

function audioOf(attachmentId: string, durationSeconds: number) {
  return audio(attachmentId, { pages: null, durationSeconds, audioKind: audioKindForDuration(durationSeconds) });
}

const photo = { attachmentId: "photo", mimeType: "image/jpeg", metadata: { pages: null, width: 10, height: 10 } };

describe("routeInboxAttachments", () => {
  it("computes an item with no attachment", () => {
    expect(routeInboxAttachments([])).toBe("compute");
  });

  it("computes an item whose attachments are not audio, whatever their metadata", () => {
    expect(routeInboxAttachments([photo, { attachmentId: "pdf", mimeType: "application/pdf", metadata: null }])).toBe(
      "compute",
    );
  });

  it("routes a 23-minute recording to the recording card", () => {
    expect(routeInboxAttachments([audioOf("long", 23 * 60)])).toEqual({ recording: "long" });
  });

  it.each([
    [119, "compute"],
    [120, { recording: "a" }],
    [121, { recording: "a" }],
  ])("routes audio of %i seconds by the boundary of the metadata job", (seconds, expected) => {
    expect(routeInboxAttachments([audioOf("a", seconds)])).toEqual(expected);
  });

  it("computes a 40-second voice note", () => {
    expect(routeInboxAttachments([audioOf("note", 40)])).toBe("compute");
  });

  it("is not ready while an audio attachment has no metadata", () => {
    expect(routeInboxAttachments([audio("a", null)])).toBe("notReady");
  });

  it("is not ready while any audio attachment has no metadata, even next to a recording", () => {
    expect(routeInboxAttachments([audioOf("long", 600), audio("pending", null)])).toBe("notReady");
  });

  it("is not made not ready by a photo or a PDF without metadata", () => {
    expect(
      routeInboxAttachments([{ attachmentId: "photo", mimeType: "image/jpeg", metadata: null }, audioOf("long", 600)]),
    ).toEqual({ recording: "long" });
  });

  it("routes an item with a recording and a photo to the recording", () => {
    expect(routeInboxAttachments([photo, audioOf("long", 600)])).toEqual({ recording: "long" });
  });

  it("routes to the first recording by position when there are several", () => {
    expect(routeInboxAttachments([audioOf("note", 30), audioOf("first", 600), audioOf("second", 900)])).toEqual({
      recording: "first",
    });
  });

  it("computes audio that could not be read: its metadata has an error and no audio kind", () => {
    expect(routeInboxAttachments([audio("broken", { pages: null, error: "mediaUnreadable" })])).toBe("compute");
  });

  it("computes an audio attachment whose metadata has no audio kind", () => {
    expect(routeInboxAttachments([audio("odd", { pages: null, durationSeconds: 500 })])).toBe("compute");
  });
});
