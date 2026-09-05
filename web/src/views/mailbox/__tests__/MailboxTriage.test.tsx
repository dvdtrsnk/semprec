import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OperationError, type GenericOperations } from "../../../api/genericOperations.js";
import { createFakeOperations } from "../../../test/fakeOperations.js";
import { createMailboxBackend } from "../../../test/mailboxFixture.js";
import { renderMailbox, setViewport } from "../../../test/renderMailbox.js";

/** Every row is a list item; the message it belongs to is named by its subject. */
async function rows(): Promise<HTMLElement[]> {
  const messages = await screen.findByRole("region", { name: "Messages" });
  return within(messages).findAllByRole("listitem");
}

async function row(subject: string): Promise<HTMLElement> {
  const found = (await rows()).find((candidate) => candidate.textContent?.includes(subject));
  if (!found) throw new Error(`No message row for '${subject}'`);
  return found;
}

async function subjects(): Promise<string[]> {
  return (await rows()).map((candidate) => candidate.textContent ?? "");
}

function folderButton(name: string): HTMLElement {
  return within(screen.getByRole("region", { name: "Folders" })).getByRole("button", { name: new RegExp(name) });
}

function toolbar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selected messages" });
}

describe("mailbox triage (issue #97)", () => {
  beforeEach(() => setViewport(false));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("row actions", () => {
    it("archives a message by moving it onto the Archive folder through the relation operations", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Invoice for March")).getByRole("button", { name: "Archive" }));

      await waitFor(async () => expect(await subjects()).toHaveLength(2));
      expect(await subjects()).not.toContainEqual(expect.stringContaining("Invoice for March"));
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-1", targetItemId: "folder-archive" });
      expect(backend.relations).not.toContainEqual({ property: "folder", itemId: "email-1", targetItemId: "folder-inbox" });
      // The archived message was unread, so the Inbox is down to one unread and the Archive
      // now has one of its own.
      await waitFor(() => expect(within(folderButton("Inbox")).getByLabelText("1 unread")).toBeInTheDocument());
      expect(within(folderButton("Archive")).getByLabelText("1 unread")).toBeInTheDocument();
    });

    it("deletes a message by moving it onto the Trash folder", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Lunch?")).getByRole("button", { name: "Delete" }));

      await waitFor(async () => expect(await subjects()).toHaveLength(2));
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-2", targetItemId: "folder-trash" });
    });

    it("marks a message read and back to unread through the generic item update", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Invoice for March")).getByRole("button", { name: "Mark as read" }));

      await waitFor(async () => expect(within(await row("Invoice for March")).queryByLabelText("Unread")).toBeNull());
      expect(backend.items.find((item) => item.id === "email-1")?.properties.read).toBe(true);
      await waitFor(() => expect(within(folderButton("Inbox")).getByLabelText("1 unread")).toBeInTheDocument());

      await user.click(within(await row("Invoice for March")).getByRole("button", { name: "Mark as unread" }));

      await waitFor(async () => expect(within(await row("Invoice for March")).getByLabelText("Unread")).toBeInTheDocument());
      expect(backend.items.find((item) => item.id === "email-1")?.properties.read).toBe(false);
      await waitFor(() => expect(within(folderButton("Inbox")).getByLabelText("2 unread")).toBeInTheDocument());
    });

    it("flags and unflags a message, persisting the flag as an ordinary property", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Lunch?")).getByRole("button", { name: "Flag" }));

      await waitFor(async () => expect(within(await row("Lunch?")).getByLabelText("Flagged")).toBeInTheDocument());
      expect(backend.items.find((item) => item.id === "email-2")?.properties.flagged).toBe(true);

      await user.click(within(await row("Lunch?")).getByRole("button", { name: "Unflag" }));
      await waitFor(async () => expect(within(await row("Lunch?")).queryByLabelText("Flagged")).toBeNull());
    });

    it("treats a message with neither flag property as unread and unflagged", async () => {
      renderMailbox(createFakeOperations(createMailboxBackend()));

      // 'Lunch?' is the legacy-shaped fixture message: no `read`, no `flagged`.
      const legacy = await row("Lunch?");
      expect(within(legacy).getByLabelText("Unread")).toBeInTheDocument();
      expect(within(legacy).queryByLabelText("Flagged")).toBeNull();
      expect(within(legacy).getByRole("button", { name: "Mark as read" })).toBeInTheDocument();
      expect(within(legacy).getByRole("button", { name: "Flag" })).toBeInTheDocument();
    });

    it("offers no move into the folder already being read", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));

      await user.click(within(await row("Invoice for March")).getByRole("button", { name: "Archive" }));
      await waitFor(async () => expect(await subjects()).toHaveLength(2));
      await user.click(folderButton("Archive"));

      const archived = await row("Invoice for March");
      expect(within(archived).queryByRole("button", { name: "Archive" })).toBeNull();
      expect(within(archived).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
  });

  describe("bulk selection", () => {
    it("applies an action to exactly the selected messages and then clears the selection", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Invoice for March")).getByRole("checkbox"));
      await user.click(within(await row("Lunch?")).getByRole("checkbox"));
      expect(within(toolbar()).getByText("2 selected")).toBeInTheDocument();

      await user.click(within(toolbar()).getByRole("button", { name: "Mark as read" }));

      await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected messages" })).toBeNull());
      expect(backend.items.find((item) => item.id === "email-1")?.properties.read).toBe(true);
      expect(backend.items.find((item) => item.id === "email-2")?.properties.read).toBe(true);
      // The message that was never selected is untouched.
      expect(backend.items.find((item) => item.id === "email-3")?.properties.read).toBe(true);
      await waitFor(() => expect(within(folderButton("Inbox")).queryByLabelText(/unread/)).toBeNull());
    });

    it("archives every selected message and leaves the rest of the folder alone", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Invoice for March")).getByRole("checkbox"));
      await user.click(within(await row("Newsletter")).getByRole("checkbox"));
      await user.click(within(toolbar()).getByRole("button", { name: "Archive" }));

      await waitFor(async () => expect(await subjects()).toEqual([expect.stringContaining("Lunch?")]));
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-3", targetItemId: "folder-archive" });
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-2", targetItemId: "folder-inbox" });
    });

    it("reports a partial failure and keeps exactly the messages it could not update selected", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      const inner = createFakeOperations(backend);
      const operations: GenericOperations = {
        ...inner,
        updateItem: async (databaseId, itemId, patch) => {
          if (itemId === "email-2") throw new OperationError("retryable", "Timed out");
          return inner.updateItem(databaseId, itemId, patch);
        },
      };
      renderMailbox(operations);

      await user.click(within(await row("Invoice for March")).getByRole("checkbox"));
      await user.click(within(await row("Lunch?")).getByRole("checkbox"));
      await user.click(within(toolbar()).getByRole("button", { name: "Flag" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("1 of 2 messages could not be updated");
      expect(within(toolbar()).getByText("1 selected")).toBeInTheDocument();
      expect(within(await row("Lunch?")).getByRole("checkbox")).toBeChecked();
      expect(within(await row("Invoice for March")).getByRole("checkbox")).not.toBeChecked();
      expect(backend.items.find((item) => item.id === "email-1")?.properties.flagged).toBe(true);
    });

    it("drops the selection when the folder changes, so the toolbar never acts off-screen", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));

      await user.click(within(await row("Invoice for March")).getByRole("checkbox"));
      expect(toolbar()).toBeInTheDocument();

      await user.click(folderButton("Archive"));
      await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected messages" })).toBeNull());
    });
  });

  describe("keyboard", () => {
    it("moves the cursor with j/k, focusing the message it lands on", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));
      await rows();

      await user.keyboard("j");
      expect(within(await row("Invoice for March")).getByRole("button", { name: /Invoice for March/ })).toHaveFocus();

      await user.keyboard("j");
      expect(within(await row("Lunch?")).getByRole("button", { name: /Lunch\?/ })).toHaveFocus();

      await user.keyboard("k");
      expect(within(await row("Invoice for March")).getByRole("button", { name: /Invoice for March/ })).toHaveFocus();
    });

    it("archives the message under the cursor with e and leaves the cursor on the next one", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));
      await rows();

      await user.keyboard("j");
      await user.keyboard("e");

      await waitFor(async () => expect(await subjects()).toHaveLength(2));
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "email-1", targetItemId: "folder-archive" });
      await waitFor(() => expect(within(screen.getByText("Lunch?").closest("li") as HTMLElement).getByRole("button", { name: /Lunch\?/ })).toHaveFocus());
    });

    it("archives the whole selection with e when there is one", async () => {
      const user = userEvent.setup();
      const backend = createMailboxBackend();
      renderMailbox(createFakeOperations(backend));

      await user.click(within(await row("Invoice for March")).getByRole("checkbox"));
      await user.click(within(await row("Newsletter")).getByRole("checkbox"));
      await user.keyboard("e");

      await waitFor(async () => expect(await subjects()).toEqual([expect.stringContaining("Lunch?")]));
    });

    it("stays silent while the user is typing in an editable control", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));
      await rows();

      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      await user.keyboard("je");

      expect(input).toHaveValue("je");
      expect(input).toHaveFocus();
      // Neither a cursor move nor an archive happened.
      expect(await subjects()).toHaveLength(3);
      input.remove();
    });
  });
});
