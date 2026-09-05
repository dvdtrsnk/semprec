import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFakeOperations, type FakeBackend } from "../../../test/fakeOperations.js";
import { ALIAS_ADDRESS, PRIMARY_ADDRESS, createMailboxBackend } from "../../../test/mailboxFixture.js";
import { renderMailbox, setViewport } from "../../../test/renderMailbox.js";

function composeWindow(): HTMLElement {
  return screen.getByRole("dialog", { name: "New message" });
}

async function openMessage(subject: string): Promise<void> {
  const messages = await screen.findByRole("region", { name: "Messages" });
  await userEvent.click(await within(messages).findByRole("button", { name: new RegExp(subject) }));
}

async function startReply(mode: "Reply" | "Reply to all"): Promise<HTMLElement> {
  const message = await screen.findByRole("region", { name: "Message" });
  await userEvent.click(await within(message).findByRole("button", { name: mode }));
  return screen.getByRole("region", { name: mode });
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  return within(container).getByLabelText(label) as HTMLInputElement;
}

async function renderReady(backend: FakeBackend) {
  const operations = createFakeOperations(backend);
  renderMailbox(operations);
  await screen.findByRole("button", { name: /Inbox/ });
  return operations;
}

describe("mailbox compose (issue #98)", () => {
  beforeEach(() => setViewport(false));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("the floating window", () => {
    it("opens over the mailbox, defaulting From to the account whose folder is open", async () => {
      await renderReady(createMailboxBackend());

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      expect(field(composeWindow(), "From").value).toBe(PRIMARY_ADDRESS);
      // The reading pane is still there underneath — composing never replaces it.
      expect(screen.getByRole("region", { name: "Message" })).toBeInTheDocument();
    });

    it("keeps everything typed when minimized and restored", async () => {
      await renderReady(createMailboxBackend());

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "To"), "ada@example.com");
      await userEvent.type(field(composeWindow(), "Message"), "half a thought");

      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Minimize" }));
      expect(within(composeWindow()).queryByLabelText("Message")).toBeNull();

      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Restore" }));
      expect(field(composeWindow(), "To").value).toBe("ada@example.com");
      expect(field(composeWindow(), "Message").value).toBe("half a thought");
    });

    it("survives reading another message, and reopening brings the same window back", async () => {
      await renderReady(createMailboxBackend());

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "Subject"), "Still here");

      await openMessage("Newsletter");
      await screen.findByText("Read on.");
      await userEvent.click(screen.getByRole("button", { name: "New message" }));

      expect(field(composeWindow(), "Subject").value).toBe("Still here");
    });
  });

  describe("reply", () => {
    it("addresses the sender and defaults From to the alias the message was delivered to", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");

      expect(field(reply, "To").value).toBe("Billing <billing@example.com>");
      expect(field(reply, "Subject").value).toBe("Re: Invoice for March");
      expect(field(reply, "Message").value).toContain("> Attached.");
      // The stored envelope says this one was delivered to the second alias, not the primary.
      expect(field(reply, "From").value).toBe(ALIAS_ADDRESS);
    });

    it("derives reply-all from the structured envelope, not from the displayed recipients", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Invoice for March");
      const reply = await startReply("Reply to all");

      // The row only displays `me@example.com`; To and Cc come from the envelope, minus the
      // user's own alias.
      expect(field(reply, "To").value).toBe("Billing <billing@example.com>, Ada <ada@example.com>");
      expect(field(reply, "Cc").value).toBe("books@example.com");
    });

    it("still replies to a message the mail module has no envelope for", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Lunch?");
      const reply = await startReply("Reply");

      expect(field(reply, "To").value).toBe("friend@example.com");
      expect(field(reply, "From").value).toBe(PRIMARY_ADDRESS);
    });

    it("lets the user override the default sender", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");
      await userEvent.selectOptions(field(reply, "From"), PRIMARY_ADDRESS);

      expect(field(reply, "From").value).toBe(PRIMARY_ADDRESS);
    });

    it("keeps a half-written reply while another message is read", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");
      await userEvent.type(field(reply, "Message"), "Thanks, ");

      await openMessage("Newsletter");
      await screen.findByText("Read on.");
      expect(screen.queryByRole("region", { name: "Reply" })).toBeNull();

      await openMessage("Invoice for March");
      const restored = await screen.findByRole("region", { name: "Reply" });
      expect(field(restored, "Message").value).toContain("Thanks, ");
    });
  });

  describe("saving and sending", () => {
    it("saves through email.draft.create, into the Drafts folder", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "Subject"), "Later");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Save draft" }));

      await waitFor(() => expect(backend.mail?.drafts).toEqual(["draft-1"]));
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "draft-1", targetItemId: "folder-drafts" });
      // Create-only draft surface: the window says the draft exists rather than saving a second one.
      expect(within(composeWindow()).getByRole("button", { name: "Save draft" })).toBeDisabled();
    });

    it("sends the reply through email.send with the envelope-derived recipients and the chosen alias", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await openMessage("Invoice for March");
      const reply = await startReply("Reply to all");
      await userEvent.click(within(reply).getByRole("button", { name: "Send" }));

      await waitFor(() => expect(backend.mail?.sent).toHaveLength(1));
      const sent = backend.mail?.sent[0];
      expect(sent?.payload.from).toEqual({ address: ALIAS_ADDRESS });
      expect(sent?.payload.to).toEqual([
        { name: "Billing", address: "billing@example.com" },
        { name: "Ada", address: "ada@example.com" },
      ]);
      expect(sent?.payload.cc).toEqual([{ address: "books@example.com" }]);
      // Threading is carried over from the message being answered.
      expect(sent?.payload.inReplyTo).toBe("<invoice-1@example.com>");
      expect(sent?.payload.references).toEqual(["<thread-root@example.com>", "<invoice-1@example.com>"]);
      // The draft it was sent from now lives in Sent, and the reply form is gone.
      expect(backend.relations).toContainEqual({ property: "folder", itemId: sent?.draftItemId, targetItemId: "folder-sent" });
      await waitFor(() => expect(screen.queryByRole("region", { name: "Reply to all" })).toBeNull());
    });

    it("leaves an editable draft and a visible error when the send is rejected", async () => {
      const backend = createMailboxBackend();
      if (backend.mail) backend.mail.rejectSend = "SMTP host refused the message";
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "To"), "ada@example.com");
      await userEvent.type(field(composeWindow(), "Subject"), "Please deliver");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Send" }));

      expect(await within(composeWindow()).findByRole("alert")).toHaveTextContent("SMTP host refused the message");
      // The draft the send was attempted from survives, and the window is still editable.
      expect(backend.mail?.drafts).toEqual(["draft-1"]);
      expect(backend.mail?.sent).toHaveLength(0);
      expect(field(composeWindow(), "Subject").value).toBe("Please deliver");
      await userEvent.type(field(composeWindow(), "Subject"), " today");
      expect(field(composeWindow(), "Subject").value).toBe("Please deliver today");
    });

    it("refuses to send with no recipient, without calling the backend", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Send" }));

      expect(await within(composeWindow()).findByRole("alert")).toHaveTextContent("Add at least one recipient");
      expect(backend.mail?.drafts).toEqual([]);
    });
  });
});
