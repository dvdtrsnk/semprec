import { describe, expect, it } from "vitest";
import { INBOX_ATTACHMENT_MIME_TYPES, isAllowedInboxAttachmentMime } from "../attachmentTypes.js";

describe("Inbox attachment types (issue gh-1963)", () => {
  it("lists PDF, JPEG, PNG, XLSX, DOCX, M4A and MP3", () => {
    expect([...INBOX_ATTACHMENT_MIME_TYPES].sort()).toEqual(
      [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "audio/mp4",
        "audio/mpeg",
        "audio/x-m4a",
        "image/jpeg",
        "image/png",
      ].sort(),
    );
  });

  it.each(INBOX_ATTACHMENT_MIME_TYPES)("allows %s", (mime) => {
    expect(isAllowedInboxAttachmentMime(mime)).toBe(true);
  });

  it.each(["image/heic", "image/gif", "application/octet-stream", "text/plain", "audio/wav", "", "IMAGE/PNG"])(
    "refuses %j",
    (mime) => {
      expect(isAllowedInboxAttachmentMime(mime)).toBe(false);
    },
  );
});
