import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OperationError, type GenericOperations } from "../../../api/genericOperations.js";
import { createFakeOperations } from "../../../test/fakeOperations.js";
import { EMAILS_DATABASE_ID, createMailboxBackend, mailboxView } from "../../../test/mailboxFixture.js";
import { renderMailbox, setViewport } from "../../../test/renderMailbox.js";

function panes() {
  return {
    folders: screen.queryByRole("region", { name: "Folders" }),
    messages: screen.queryByRole("region", { name: "Messages" }),
    message: screen.queryByRole("region", { name: "Message" }),
  };
}

describe("MailboxClient", () => {
  beforeEach(() => setViewport(false));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("wide layout", () => {
    it("shows all three panes, opens on the Inbox, and lists its messages newest first", async () => {
      renderMailbox(createFakeOperations(createMailboxBackend()));

      await screen.findByRole("button", { name: /Inbox/ });
      const { folders, messages, message } = panes();
      expect(folders).not.toBeNull();
      expect(messages).not.toBeNull();
      expect(message).not.toBeNull();

      const listed = await within(messages as HTMLElement).findAllByRole("listitem");
      expect(listed.map((row) => row.textContent)).toEqual([
        expect.stringContaining("Invoice for March"),
        expect.stringContaining("Lunch?"),
        expect.stringContaining("Newsletter"),
      ]);
      expect(within(folders as HTMLElement).getByRole("button", { name: /Inbox/ })).toHaveAttribute("aria-current", "true");
    });

    it("shows the unread count per folder, counting a message with no read flag as unread", async () => {
      renderMailbox(createFakeOperations(createMailboxBackend()));

      const inbox = await screen.findByRole("button", { name: /Inbox/ });
      expect(within(inbox).getByLabelText("2 unread")).toHaveTextContent("2");
      const archive = within(panes().folders as HTMLElement).getByRole("button", { name: /Archive/ });
      expect(within(archive).queryByText("0")).toBeNull();
    });

    it("lists only the folders of the mailbox this view is scoped to", async () => {
      renderMailbox(createFakeOperations(createMailboxBackend()));

      await screen.findByRole("button", { name: /Inbox/ });
      expect(screen.queryByRole("button", { name: /Work inbox/ })).toBeNull();
    });

    it("switches folders and reads a message through the generic item operation", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));

      const folders = (await screen.findByRole("region", { name: "Folders" })) as HTMLElement;
      await user.click(within(folders).getByRole("button", { name: /Archive/ }));
      expect(await screen.findByText("No messages in this folder")).toBeInTheDocument();

      await user.click(within(folders).getByRole("button", { name: /Inbox/ }));
      await user.click(await screen.findByRole("button", { name: /Invoice for March/ }));

      const message = panes().message as HTMLElement;
      expect(await within(message).findByRole("heading", { name: "Invoice for March" })).toBeInTheDocument();
      expect(within(message).getByText("billing@example.com")).toBeInTheDocument();
      expect(within(message).getByText("Attached.")).toBeInTheDocument();
    });

    it("shows the empty-folder state when the mailbox has no folders at all", async () => {
      const backend = createMailboxBackend();
      backend.relations = backend.relations.filter((edge) => edge.property !== "mailbox");
      renderMailbox(createFakeOperations(backend));

      expect(await screen.findByText("No folders yet")).toBeInTheDocument();
    });
  });

  describe("states", () => {
    it("shows a loading state until the folders resolve", async () => {
      let release: (() => void) | undefined;
      const backend = createMailboxBackend();
      const inner = createFakeOperations(backend);
      const operations: GenericOperations = {
        ...inner,
        listItems: async (databaseId, request) => {
          if (databaseId !== EMAILS_DATABASE_ID) await new Promise<void>((resolve) => (release = resolve));
          return inner.listItems(databaseId, request);
        },
      };
      renderMailbox(operations);

      expect(within(panes().folders as HTMLElement).getByRole("status")).toHaveTextContent("Loading…");
      release?.();
      expect(await screen.findByRole("button", { name: /Inbox/ })).toBeInTheDocument();
    });

    it("offers a retry on a retryable failure and recovers when the retry succeeds", async () => {
      const user = userEvent.setup();
      const inner = createFakeOperations(createMailboxBackend());
      let failNext = true;
      const operations: GenericOperations = {
        ...inner,
        listItems: async (databaseId, request) => {
          if (failNext) {
            failNext = false;
            throw new OperationError("retryable", "Connection lost", 503);
          }
          return inner.listItems(databaseId, request);
        },
      };
      renderMailbox(operations);

      expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: /Inbox/ })).toBeInTheDocument();
    });

    it("shows an unavailable state with no retry when the mailbox cannot be read at all", async () => {
      const inner = createFakeOperations(createMailboxBackend());
      const operations: GenericOperations = {
        ...inner,
        listItems: async () => {
          throw new OperationError("unavailable", "Request to /databases/db-folders/items/query failed with 403", 403);
        },
      };
      renderMailbox(operations);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Not available");
      expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("keeps the message list's own failure inside the message pane, with its own retry", async () => {
      const inner = createFakeOperations(createMailboxBackend());
      const operations: GenericOperations = {
        ...inner,
        listItems: async (databaseId, request) => {
          if (databaseId === EMAILS_DATABASE_ID) throw new OperationError("retryable", "Timed out");
          return inner.listItems(databaseId, request);
        },
      };
      renderMailbox(operations);

      await screen.findByRole("button", { name: /Inbox/ });
      const messages = panes().messages as HTMLElement;
      expect(await within(messages).findByRole("alert")).toHaveTextContent("Timed out");
      expect(within(messages).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("renders the unconfigured state for a view whose config is not a mailbox config", async () => {
      renderMailbox(createFakeOperations(createMailboxBackend()), { view: { ...mailboxView, config: {} } });

      expect(await screen.findByText("This mailbox view is not configured correctly")).toBeInTheDocument();
    });
  });

  describe("narrow layout", () => {
    beforeEach(() => setViewport(true));

    it("shows one pane at a time and walks back from message to messages to folders", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));

      // Opening on the Inbox means the message list is the visible pane, not the sidebar.
      const messages = await screen.findByRole("region", { name: "Messages" });
      expect(panes().folders).toBeNull();
      expect(panes().message).toBeNull();

      await user.click(await within(messages).findByRole("button", { name: /Invoice for March/ }));
      await waitFor(() => expect(panes().message).not.toBeNull());
      expect(panes().messages).toBeNull();

      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(panes().messages).not.toBeNull());
      expect(panes().message).toBeNull();

      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(panes().folders).not.toBeNull());
      expect(panes().messages).toBeNull();
      // The first pane has nowhere to go back to.
      expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    });

    it("re-selecting a folder after going back opens its message list again", async () => {
      const user = userEvent.setup();
      renderMailbox(createFakeOperations(createMailboxBackend()));

      await screen.findByRole("region", { name: "Messages" });
      await user.click(screen.getByRole("button", { name: "Back" }));
      const folders = (await screen.findByRole("region", { name: "Folders" })) as HTMLElement;
      await user.click(within(folders).getByRole("button", { name: /Archive/ }));

      await waitFor(() => expect(panes().messages).not.toBeNull());
      expect(await screen.findByText("No messages in this folder")).toBeInTheDocument();
    });
  });

  it("translates its chrome into the resolved locale", async () => {
    renderMailbox(createFakeOperations(createMailboxBackend()), { locale: "cs" });

    expect(await screen.findByRole("region", { name: "Složky" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Zprávy" })).toBeInTheDocument();
  });
});
