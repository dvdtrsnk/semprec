import { describe, expect, it } from "vitest";
import type { GenericOperations, Item, ItemPage } from "../../../api/genericOperations.js";
import { createFakeOperations } from "../../../test/fakeOperations.js";
import {
  createMailboxBackend,
  FOLDERS_DATABASE_ID,
  MAILBOX_ITEM_ID,
  MAILBOXES_DATABASE_ID,
} from "../../../test/mailboxFixture.js";
import { loadFolderMailboxes } from "../accounts.js";
import type { MailboxConfig } from "../config.js";

const SECOND_MAILBOX_ID = "mailbox-work";

const unscopedConfig: MailboxConfig = {
  foldersDatabaseId: FOLDERS_DATABASE_ID,
  folderRelationKey: "folder",
  readPropertyKey: "read",
  flaggedPropertyKey: "flagged",
  mailboxesDatabaseId: MAILBOXES_DATABASE_ID,
  mailboxRelationKey: "mailbox",
  sort: [{ property: "date", direction: "desc" }],
};

function mailboxItem(id: string): Item {
  return {
    id,
    databaseId: MAILBOXES_DATABASE_ID,
    properties: {},
    computed: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("loadFolderMailboxes", () => {
  it("issues one listItems call per mailbox concurrently, resolving to the same map as resolving them in order", async () => {
    const backend = createMailboxBackend();
    backend.relations.push({ property: "mailbox", itemId: "folder-other-account", targetItemId: SECOND_MAILBOX_ID });
    const inner = createFakeOperations(backend);
    const folders = (await inner.listItems(FOLDERS_DATABASE_ID, { limit: 200 })).items;
    const mailboxes = [mailboxItem(MAILBOX_ITEM_ID), mailboxItem(SECOND_MAILBOX_ID)];

    const expected = await loadFolderMailboxes(inner, unscopedConfig, folders, mailboxes);

    let inFlight = 0;
    const releases: Array<() => void> = [];
    const operations: GenericOperations = {
      ...inner,
      listItems: (databaseId, request) => {
        if (databaseId !== FOLDERS_DATABASE_ID) return inner.listItems(databaseId, request);
        inFlight += 1;
        return new Promise<ItemPage>((resolve) => {
          releases.push(() => resolve(inner.listItems(databaseId, request)));
        });
      },
    };

    const resultPromise = loadFolderMailboxes(operations, unscopedConfig, folders, mailboxes);
    // Both per-mailbox reads are issued synchronously by Promise.all(mailboxes.map(...)), so
    // this holds before either of the deferred listItems calls below is released.
    expect(inFlight).toBe(mailboxes.length);

    releases.forEach((release) => release());
    await expect(resultPromise).resolves.toEqual(expected);
  });
});
