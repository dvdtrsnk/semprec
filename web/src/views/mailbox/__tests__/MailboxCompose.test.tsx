import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFakeOperations, type FakeBackend } from "../../../test/fakeOperations.js";
import { createFakeMailDrafts } from "../../../test/fakeMailDrafts.js";
import { ALIAS_ADDRESS, MAILBOX_ITEM_ID, PRIMARY_ADDRESS, createMailboxBackend } from "../../../test/mailboxFixture.js";
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
  return screen.findByRole("region", { name: mode });
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  return within(container).getByLabelText(label) as HTMLInputElement;
}

async function renderReady(backend: FakeBackend) {
  const operations = createFakeOperations(backend);
  renderMailbox(operations, { mailDrafts: createFakeMailDrafts(backend) });
  await screen.findByRole("button", { name: /Inbox/ });
  return operations;
}

describe("mailbox compose", () => {
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
    it("opens on the draft the backend created, from the alias it was delivered to", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");

      expect(field(reply, "To").value).toBe("Billing <billing@example.com>");
      expect(field(reply, "Subject").value).toBe("Re: Invoice for March");
      expect(field(reply, "Message").value).toContain("> Attached.");
      expect(field(reply, "From").value).toBe(ALIAS_ADDRESS);
      expect(backend.mail?.calls).toEqual([
        { kind: "create", request: { mailboxId: MAILBOX_ITEM_ID, mode: "reply", sourceEmailId: "email-1", body: "" } },
      ]);
    });

    it("addresses everyone the backend computes for a reply-all", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Invoice for March");
      const reply = await startReply("Reply to all");

      expect(field(reply, "To").value).toBe("Billing <billing@example.com>, Ada <ada@example.com>, books@example.com");
    });

    it("still replies to a message the backend has no metadata for, from its display text", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await openMessage("Lunch?");
      const reply = await startReply("Reply");

      expect(field(reply, "To").value).toBe("friend@example.com");
      expect(field(reply, "From").value).toBe(PRIMARY_ADDRESS);
      expect(field(reply, "Message").value).toContain("> Thursday?");
      expect(backend.mail?.drafts).toEqual([]);
    });

    it("shows the backend's refusal when a reply cannot be started", async () => {
      const backend = createMailboxBackend();
      const operations = createFakeOperations(backend);
      const drafts = createFakeMailDrafts(backend);
      renderMailbox(operations, {
        mailDrafts: {
          ...drafts,
          create: async () => Promise.reject(new Error("The mailbox has no address to send from")),
        },
      });

      await openMessage("Invoice for March");
      const message = await screen.findByRole("region", { name: "Message" });
      await userEvent.click(within(message).getByRole("button", { name: "Reply" }));

      expect(await within(message).findByRole("alert")).toHaveTextContent("The mailbox has no address to send from");
      expect(screen.queryByRole("region", { name: "Reply" })).toBeNull();
    });

    it("lets the user override the default sender", async () => {
      await renderReady(createMailboxBackend());

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");
      await userEvent.selectOptions(field(reply, "From"), PRIMARY_ADDRESS);

      expect(field(reply, "From").value).toBe(PRIMARY_ADDRESS);
    });

    it("widens a half-written reply to everyone without discarding what was typed", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");
      await userEvent.type(field(reply, "Message"), "On it. ");

      const widened = await startReply("Reply to all");
      expect(field(widened, "To").value).toBe(
        "Billing <billing@example.com>, Ada <ada@example.com>, books@example.com",
      );
      expect(field(widened, "Message").value).toContain("On it. ");
      expect(backend.mail?.discarded).toEqual(["draft-1"]);
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

    it("discards the started reply's draft when it is closed unsaved", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");
      await userEvent.click(within(reply).getByRole("button", { name: "Close" }));

      await waitFor(() => expect(screen.queryByRole("region", { name: "Reply" })).toBeNull());
      expect(backend.mail?.discarded).toEqual(["draft-1"]);
    });
  });

  describe("saving and sending", () => {
    it("creates the draft on the first save, into the Drafts folder", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "Subject"), "Later");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Save draft" }));

      expect(await within(composeWindow()).findByRole("status")).toHaveTextContent("Saved as a draft");
      expect(backend.mail?.drafts.map((draft) => [draft.id, draft.subject])).toEqual([["draft-1", "Later"]]);
      expect(backend.relations).toContainEqual({
        property: "folder",
        itemId: "draft-1",
        targetItemId: "folder-drafts",
      });
    });

    it("updates that same draft on a later save", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "Subject"), "Later");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Save draft" }));
      await within(composeWindow()).findByRole("status");
      await userEvent.type(field(composeWindow(), "Subject"), " on");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Save draft" }));

      await waitFor(() =>
        expect(backend.mail?.drafts.map((draft) => [draft.id, draft.subject])).toEqual([["draft-1", "Later on"]]),
      );
      expect(backend.mail?.calls.map((call) => call.kind)).toEqual(["create", "update"]);
    });

    it("sends the reply with the edits made to it, and leaves it in Sent", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await openMessage("Invoice for March");
      const reply = await startReply("Reply");
      await userEvent.type(field(reply, "Message"), "Paid.");
      await userEvent.click(within(reply).getByRole("button", { name: "Send" }));

      await waitFor(() => expect(backend.mail?.sent).toHaveLength(1));
      expect(backend.mail?.calls.map((call) => call.kind)).toEqual(["create", "update", "send"]);
      const sent = backend.mail?.sent[0];
      expect(sent).toMatchObject({ id: "draft-1", from: ALIAS_ADDRESS, sourceEmailId: "email-1" });
      expect(sent?.body.endsWith("> Attached.Paid.")).toBe(true);
      expect(backend.relations).toContainEqual({ property: "folder", itemId: "draft-1", targetItemId: "folder-sent" });
      await waitFor(() => expect(screen.queryByRole("region", { name: "Reply" })).toBeNull());
    });

    it("leaves an editable, kept draft and the backend's message when the send is rejected", async () => {
      const backend = createMailboxBackend();
      if (backend.mail) backend.mail.rejectSend = "SMTP host refused the message";
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "To"), "ada@example.com");
      await userEvent.type(field(composeWindow(), "Subject"), "Please deliver");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Send" }));

      expect(await within(composeWindow()).findByRole("alert")).toHaveTextContent("SMTP host refused the message");
      expect(backend.mail?.drafts.map((draft) => draft.id)).toEqual(["draft-1"]);
      expect(backend.mail?.sent).toHaveLength(0);
      expect(field(composeWindow(), "Subject").value).toBe("Please deliver");
      await userEvent.type(field(composeWindow(), "Subject"), " today");
      expect(field(composeWindow(), "Subject").value).toBe("Please deliver today");

      // Closing keeps the draft the refused send was attempted from.
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog", { name: "New message" })).toBeNull();
      expect(backend.mail?.discarded).toEqual([]);
    });

    it("shows the refusal of a stale draft version and keeps the window", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.type(field(composeWindow(), "Subject"), "Later");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Save draft" }));
      await within(composeWindow()).findByRole("status");
      const mail = backend.mail;
      if (!mail) throw new Error("the fixture installs the mail module");
      mail.drafts = mail.drafts.map((draft) => ({ ...draft, version: "edited-elsewhere" }));

      await userEvent.type(field(composeWindow(), "Message"), "Mine");
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Save draft" }));

      expect(await within(composeWindow()).findByRole("alert")).toHaveTextContent(
        "Draft was modified since ifVersion was read",
      );
      expect(field(composeWindow(), "Message").value).toBe("Mine");
    });

    it("refuses to send with no recipient, without calling the backend", async () => {
      const backend = createMailboxBackend();
      await renderReady(backend);

      await userEvent.click(await screen.findByRole("button", { name: "New message" }));
      await userEvent.click(within(composeWindow()).getByRole("button", { name: "Send" }));

      expect(await within(composeWindow()).findByRole("alert")).toHaveTextContent("Add at least one recipient");
      expect(backend.mail?.calls).toEqual([]);
    });
  });
});
