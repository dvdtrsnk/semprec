import { describe, expect, it } from "vitest";
import type { Item } from "../../../api/genericOperations.js";
import { parseMailboxConfig, unreadFilter, unreadOutsideDraftsAndSentFilter } from "../config.js";

const config = parseMailboxConfig({ foldersDatabaseId: "folders-database" });
if (!config) throw new Error("the fixture mailbox config must parse");

function folder(id: string, specialPurpose: string): Item {
  return {
    id,
    databaseId: "folders-database",
    properties: { name: id, specialPurpose },
    computed: {},
    updatedAt: "2026-10-29T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("unread filters in the mailbox view", () => {
  it("the folder-scoped unread filter is unchanged: it still counts every unread message in the folder", () => {
    expect(unreadFilter(config, "inbox")).toEqual({
      type: "and",
      nodes: [
        { type: "relation_contains", property: "folder", value: "inbox" },
        { type: "not_equals", property: "read", value: true },
      ],
    });
  });

  it("the unscoped unread filter leaves out a message linked to a Sent or Drafts folder (issue #1461)", () => {
    const folders = [
      folder("inbox", "inbox"),
      folder("sent", "sent"),
      folder("drafts", "drafts"),
      folder("archive", "archive"),
    ];

    expect(unreadOutsideDraftsAndSentFilter(config, folders)).toEqual({
      type: "and",
      nodes: [
        { type: "not_equals", property: "read", value: true },
        { type: "relation_not_contains", property: "folder", value: "sent" },
        { type: "relation_not_contains", property: "folder", value: "drafts" },
      ],
    });
  });

  it("excludes the Sent and Drafts folder of every mailbox the view lists, not only the first", () => {
    const folders = [
      folder("sent-a", "sent"),
      folder("drafts-a", "drafts"),
      folder("sent-b", "sent"),
      folder("drafts-b", "drafts"),
    ];

    expect(unreadOutsideDraftsAndSentFilter(config, folders)).toEqual({
      type: "and",
      nodes: [
        { type: "not_equals", property: "read", value: true },
        { type: "relation_not_contains", property: "folder", value: "sent-a" },
        { type: "relation_not_contains", property: "folder", value: "drafts-a" },
        { type: "relation_not_contains", property: "folder", value: "sent-b" },
        { type: "relation_not_contains", property: "folder", value: "drafts-b" },
      ],
    });
  });

  it("with no Sent or Drafts folder listed, the unscoped filter is only the read condition", () => {
    expect(unreadOutsideDraftsAndSentFilter(config, [folder("inbox", "inbox")])).toEqual({
      type: "and",
      nodes: [{ type: "not_equals", property: "read", value: true }],
    });
  });
});
