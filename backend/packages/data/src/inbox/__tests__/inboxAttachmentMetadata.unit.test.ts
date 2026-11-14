import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  audioKindForDuration,
  INBOX_RECORDING_MIN_SECONDS,
  inboxAttachmentMetadataJobKey,
  inboxAttachmentMetadataPayloadSchema,
  inboxAttachmentMetadataSchema,
} from "../inboxAttachmentMetadata.js";

// Issue gh-1965: the boundary between a voice note and a recording, and the shapes the metadata job writes and reads.

describe("audioKindForDuration", () => {
  it("keeps the boundary of issue gh-1978 at 120 seconds", () => {
    expect(INBOX_RECORDING_MIN_SECONDS).toBe(120);
  });

  it.each([
    { seconds: 0, kind: "voiceNote" },
    { seconds: 40, kind: "voiceNote" },
    { seconds: 119, kind: "voiceNote" },
    { seconds: 119.999, kind: "voiceNote" },
    { seconds: 120, kind: "recording" },
    { seconds: 120.001, kind: "recording" },
    { seconds: 121, kind: "recording" },
    { seconds: 23 * 60, kind: "recording" },
  ])("is a $kind for $seconds seconds", ({ seconds, kind }) => {
    expect(audioKindForDuration(seconds)).toBe(kind);
  });
});

describe("inboxAttachmentMetadataSchema", () => {
  it.each([
    { label: "an image", value: { width: 3000, height: 2000, pages: null } },
    {
      label: "audio",
      value: { durationSeconds: 40.5, recordedAt: "2024-03-01T12:00:00.000Z", audioKind: "voiceNote", pages: null },
    },
    { label: "a PDF", value: { pages: null } },
    { label: "a file that could not be read", value: { error: "mediaUnreadable", pages: null } },
  ])("accepts the metadata of $label", ({ value }) => {
    expect(inboxAttachmentMetadataSchema.parse(value)).toEqual(value);
  });

  it.each([
    { label: "no pages key", value: { width: 1, height: 1 } },
    { label: "a page count", value: { pages: 3 } },
    { label: "a non-positive width", value: { width: 0, height: 1, pages: null } },
    { label: "a fractional height", value: { width: 1, height: 1.5, pages: null } },
    { label: "a negative duration", value: { durationSeconds: -1, pages: null } },
    { label: "an unknown audio kind", value: { audioKind: "podcast", pages: null } },
    { label: "an unknown error code", value: { error: "disk on fire", pages: null } },
    { label: "a non-object", value: "mediaUnreadable" },
  ])("rejects $label", ({ value }) => {
    expect(inboxAttachmentMetadataSchema.safeParse(value).success).toBe(false);
  });

  it("drops a key it does not know when it reads", () => {
    expect(inboxAttachmentMetadataSchema.parse({ pages: null, orientation: 6 })).toEqual({ pages: null });
  });
});

describe("the metadata job's payload and key", () => {
  it("names the attachment by a UUID and nothing else is read", () => {
    const attachmentId = randomUUID();

    expect(inboxAttachmentMetadataPayloadSchema.parse({ attachmentId, tenantId: randomUUID() })).toEqual({
      attachmentId,
    });
    expect(inboxAttachmentMetadataPayloadSchema.safeParse({ attachmentId: "not-a-uuid" }).success).toBe(false);
    expect(inboxAttachmentMetadataPayloadSchema.safeParse({}).success).toBe(false);
  });

  it("keys one job per attachment", () => {
    const attachmentId = randomUUID();

    expect(inboxAttachmentMetadataJobKey(attachmentId)).toBe(`inbox-attachment-metadata:${attachmentId}`);
  });
});
