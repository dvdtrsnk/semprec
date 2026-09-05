import { describe, expect, it } from "vitest";
import { OperationError, type GenericOperations } from "../../../api/genericOperations.js";
import { createFakeOperations } from "../../../test/fakeOperations.js";
import { EMAILS_DATABASE_ID, createMailboxBackend } from "../../../test/mailboxFixture.js";
import { isEditableElement, resolveShortcut } from "../keyboard.js";
import { moveMessages, movedCursor, nextCursorAfterRemoval, setMessageFlag } from "../triage.js";

describe("triage operations", () => {
  it("reports which messages a bulk flag write reached and which it did not", async () => {
    const inner = createFakeOperations(createMailboxBackend());
    const operations: GenericOperations = {
      ...inner,
      updateItem: async (databaseId, itemId, patch) => {
        if (itemId === "email-2") throw new OperationError("retryable", "Timed out");
        return inner.updateItem(databaseId, itemId, patch);
      },
    };

    const result = await setMessageFlag(operations, { databaseId: EMAILS_DATABASE_ID, propertyKey: "read", value: true }, [
      "email-1",
      "email-2",
      "email-3",
    ]);

    expect(result.succeeded).toEqual(["email-1", "email-3"]);
    expect(result.failed.map((failure) => failure.messageId)).toEqual(["email-2"]);
    expect(result.failed[0]?.error.kind).toBe("retryable");
    expect((await inner.getItem(EMAILS_DATABASE_ID, "email-1"))?.properties.read).toBe(true);
    // The message the write never reached keeps the state it had.
    expect((await inner.getItem(EMAILS_DATABASE_ID, "email-2"))?.properties.read).toBeUndefined();
  });

  it("moves a message by linking the destination folder before unlinking the source", async () => {
    const backend = createMailboxBackend();
    const calls: string[] = [];
    const inner = createFakeOperations(backend);
    const operations: GenericOperations = {
      ...inner,
      linkItem: async (...args) => {
        calls.push(`link:${args[3]}`);
        return inner.linkItem(...args);
      },
      unlinkItem: async (...args) => {
        calls.push(`unlink:${args[3]}`);
        return inner.unlinkItem(...args);
      },
    };

    const result = await moveMessages(
      operations,
      { databaseId: EMAILS_DATABASE_ID, relationKey: "folder", fromFolderId: "folder-inbox", toFolderId: "folder-archive" },
      ["email-1"],
    );

    expect(result.succeeded).toEqual(["email-1"]);
    expect(calls).toEqual(["link:folder-archive", "unlink:folder-inbox"]);
    expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-1", targetItemId: "folder-archive" });
    expect(backend.relations).not.toContainEqual({ property: "folder", itemId: "email-1", targetItemId: "folder-inbox" });
  });

  it("leaves a message linked to its folder when the unlink half fails", async () => {
    const backend = createMailboxBackend();
    const inner = createFakeOperations(backend);
    const operations: GenericOperations = { ...inner, unlinkItem: async () => Promise.reject(new OperationError("retryable", "Timed out")) };

    const result = await moveMessages(
      operations,
      { databaseId: EMAILS_DATABASE_ID, relationKey: "folder", fromFolderId: "folder-inbox", toFolderId: "folder-archive" },
      ["email-1"],
    );

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-1", targetItemId: "folder-inbox" });
  });
});

describe("cursor movement", () => {
  const ids = ["a", "b", "c"];

  it("moves to the neighbour and stops at both ends instead of wrapping", () => {
    expect(movedCursor(ids, null, 1)).toBe("a");
    expect(movedCursor(ids, null, -1)).toBe("c");
    expect(movedCursor(ids, "a", 1)).toBe("b");
    expect(movedCursor(ids, "c", 1)).toBe("c");
    expect(movedCursor(ids, "a", -1)).toBe("a");
    expect(movedCursor([], "a", 1)).toBeNull();
  });

  it("lands on the next surviving message when the messages under it are triaged away", () => {
    expect(nextCursorAfterRemoval(ids, "a", ["a"])).toBe("b");
    expect(nextCursorAfterRemoval(ids, "b", ["b", "c"])).toBe("a");
    expect(nextCursorAfterRemoval(ids, "b", ["a"])).toBe("b");
    expect(nextCursorAfterRemoval(ids, "a", ids)).toBeNull();
    expect(nextCursorAfterRemoval(ids, null, ["a"])).toBeNull();
  });
});

describe("keyboard shortcuts", () => {
  function keydown(key: string, target: EventTarget | null = null, modifiers: Partial<KeyboardEvent> = {}) {
    return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target, ...modifiers };
  }

  it("resolves j/k/e, ignores everything else and every modifier combination", () => {
    expect(resolveShortcut(keydown("j"))).toBe("cursorNext");
    expect(resolveShortcut(keydown("K"))).toBe("cursorPrevious");
    expect(resolveShortcut(keydown("e"))).toBe("archive");
    expect(resolveShortcut(keydown("x"))).toBeNull();
    expect(resolveShortcut(keydown("e", null, { metaKey: true }))).toBeNull();
  });

  it("goes silent inside anything the user can type into", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(editable)).toBe(true);
    expect(isEditableElement(document.createElement("textarea"))).toBe(true);
    expect(isEditableElement(document.createElement("div"))).toBe(false);
    // A checkbox holds no text: the row selection boxes must not swallow the shortcuts.
    expect(isEditableElement(checkbox)).toBe(false);
    expect(resolveShortcut(keydown("j", input))).toBeNull();
    expect(resolveShortcut(keydown("j", checkbox))).toBe("cursorNext");
  });
});
