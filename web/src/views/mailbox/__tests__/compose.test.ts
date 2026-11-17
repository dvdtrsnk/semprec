import { describe, expect, it } from "vitest";
import type { Item } from "../../../api/genericOperations.js";
import { parseAddressList } from "../addresses.js";
import {
  aliasOptions,
  closeCompose,
  composeFields,
  defaultFromAddress,
  localReplyCompose,
  newCompose,
  pendingChanges,
  replySubject,
  saveComposeDraft,
  sendCompose,
  startReplyCompose,
  switchReplyMode,
  type AliasOption,
  type ComposeState,
} from "../compose.js";
import { createFakeMailDrafts, type FakeMailModule } from "../../../test/fakeMailDrafts.js";
import type { FakeBackend } from "../../../test/fakeOperations.js";
import { ALIAS_ADDRESS, MAILBOX_ITEM_ID, PRIMARY_ADDRESS, createMailboxBackend } from "../../../test/mailboxFixture.js";

const aliases: AliasOption[] = [
  { address: "me@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
  { address: "alias@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
  { address: "work@example.com", mailboxItemId: "mailbox-work", mailboxName: "Work" },
];

function message(properties: Record<string, unknown>): Item {
  return {
    id: "email-legacy",
    databaseId: "db-emails",
    properties,
    computed: {},
    updatedAt: "",
    deletedAt: null,
    version: "1",
  };
}

/** The fixture mailbox plus a second account, `work@example.com`, with its own Drafts and Trash. */
function twoAccountBackend(): { backend: FakeBackend; mail: FakeMailModule } {
  const backend = createMailboxBackend();
  backend.items.push(
    { id: "mailbox-work", databaseId: "db-mailboxes", properties: { name: "Work", addresses: "work@example.com" } },
    { id: "folder-work-drafts", databaseId: "db-folders", properties: { name: "Drafts", specialPurpose: "drafts" } },
    { id: "folder-work-trash", databaseId: "db-folders", properties: { name: "Trash", specialPurpose: "trash" } },
  );
  backend.relations.push(
    { property: "mailbox", itemId: "folder-work-drafts", targetItemId: "mailbox-work" },
    { property: "mailbox", itemId: "folder-work-trash", targetItemId: "mailbox-work" },
  );
  if (!backend.mail) throw new Error("the mailbox fixture installs the mail module");
  return { backend, mail: backend.mail };
}

function writtenNew(overrides: Partial<ComposeState> = {}): ComposeState {
  return { ...newCompose(PRIMARY_ADDRESS), to: "Ada <ada@example.com>", subject: "Hi", body: "Hello", ...overrides };
}

describe("compose recipients", () => {
  it("keeps a quoted display name that contains the separator as one address", () => {
    expect(parseAddressList('"Doe, John" <john@example.com>, ada@example.com')).toEqual([
      { name: "Doe, John", address: "john@example.com" },
      { address: "ada@example.com" },
    ]);
  });

  it("drops a repeated address, however it is written", () => {
    expect(parseAddressList("Ada <ada@example.com>\nADA@example.com")).toEqual([
      { name: "Ada", address: "ada@example.com" },
    ]);
  });

  it("prefixes the subject once", () => {
    expect(replySubject("Invoice")).toBe("Re: Invoice");
    expect(replySubject("RE: Invoice")).toBe("RE: Invoice");
  });
});

describe("compose sender", () => {
  it("reads the registered aliases off the mailboxes, keeping their order", () => {
    const options = aliasOptions([
      {
        id: "mailbox-personal",
        databaseId: "db",
        properties: { name: "Personal", addresses: "me@example.com\nalias@example.com" },
        computed: {},
        updatedAt: "",
        deletedAt: null,
        version: "1",
      },
    ]);
    expect(options).toEqual([
      { address: "me@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
      { address: "alias@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
    ]);
  });

  it("defaults to the account whose folder is open", () => {
    expect(defaultFromAddress({ aliases, contextMailboxItemId: "mailbox-work" })).toBe("work@example.com");
  });

  it("falls back to the primary address when there is no context", () => {
    expect(defaultFromAddress({ aliases })).toBe("me@example.com");
  });
});

describe("compose fields", () => {
  it("writes from the chosen alias, with every recipient in the draft routes' shape", () => {
    const state = { ...newCompose("work@example.com"), to: "Ada <ada@example.com>", bcc: "b@example.com" };
    expect(composeFields(state, aliases, { requireRecipients: true })).toEqual({
      ok: true,
      alias: aliases[2],
      fields: {
        from: "work@example.com",
        to: [{ address: "ada@example.com", name: "Ada" }],
        cc: [],
        bcc: [{ address: "b@example.com", name: "" }],
        subject: "",
        body: "",
      },
    });
  });

  it("refuses to send without a recipient, but saves a draft that has none", () => {
    const state = newCompose("me@example.com");
    expect(composeFields(state, aliases, { requireRecipients: true })).toEqual({ ok: false, problem: "noRecipients" });
    expect(composeFields(state, aliases, { requireRecipients: false }).ok).toBe(true);
  });

  it("refuses an address that is not a registered alias", () => {
    expect(
      composeFields({ ...newCompose("nobody@example.com"), to: "ada@example.com" }, aliases, {
        requireRecipients: true,
      }),
    ).toEqual({ ok: false, problem: "noSender" });
  });

  it("reports only the fields that differ from the draft", async () => {
    const draft = await createFakeMailDrafts(createMailboxBackend()).create({
      mailboxId: MAILBOX_ITEM_ID,
      mode: "new",
      threadId: null,
      from: PRIMARY_ADDRESS,
      to: [{ address: "ada@example.com", name: "Ada" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      body: "Hello",
    });
    const result = composeFields(writtenNew({ body: "Hello again" }), aliases, { requireRecipients: false });
    if (!result.ok) throw new Error("the fields are valid");
    expect(pendingChanges(draft, result.fields)).toEqual({ body: "Hello again" });
  });
});

describe("saving a draft", () => {
  it("creates a new message's draft on the first save, in the chosen alias's mailbox", async () => {
    const backend = createMailboxBackend();
    const saved = await saveComposeDraft(createFakeMailDrafts(backend), writtenNew(), aliases);

    expect(backend.mail?.calls).toEqual([
      {
        kind: "create",
        request: {
          mailboxId: MAILBOX_ITEM_ID,
          mode: "new",
          threadId: null,
          from: PRIMARY_ADDRESS,
          to: [{ address: "ada@example.com", name: "Ada" }],
          cc: [],
          bcc: [],
          subject: "Hi",
          body: "Hello",
        },
      },
    ]);
    expect(saved.draft?.id).toBe("draft-1");
    expect(saved.kept).toBe(true);
    expect(saved.error).toBeNull();
  });

  it("updates the same draft on a later save, with the version it last read and only what changed", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const first = await saveComposeDraft(drafts, writtenNew(), aliases);
    const second = await saveComposeDraft(drafts, { ...first, subject: "Hi there" }, aliases);

    expect(backend.mail?.calls[1]).toEqual({
      kind: "update",
      draftId: "draft-1",
      version: first.draft?.version,
      fields: { subject: "Hi there" },
    });
    expect(second.draft?.version).not.toBe(first.draft?.version);
    expect(backend.mail?.drafts.map((draft) => [draft.id, draft.subject])).toEqual([["draft-1", "Hi there"]]);
  });

  it("does not call the backend again when nothing changed since the last save", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const first = await saveComposeDraft(drafts, writtenNew(), aliases);
    await saveComposeDraft(drafts, first, aliases);

    expect(backend.mail?.calls).toHaveLength(1);
  });

  it("shows the backend's refusal of a stale version and keeps the window's content and draft", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const first = await saveComposeDraft(drafts, writtenNew(), aliases);
    // Someone else (an agent, another tab) edits the draft in the meantime.
    const [stored] = backend.mail?.drafts ?? [];
    if (!stored || !backend.mail) throw new Error("the first save created a draft");
    backend.mail.drafts = [{ ...stored, version: "edited-elsewhere" }];

    const refused = await saveComposeDraft(drafts, { ...first, body: "Mine" }, aliases);

    expect(refused.error).toEqual({ kind: "failed", message: "Draft was modified since ifVersion was read" });
    expect(refused.body).toBe("Mine");
    expect(refused.draft?.id).toBe("draft-1");
    expect(refused.kept).toBe(true);
  });

  it("moves the content into a new draft when an alias of another account is chosen, discarding the old one", async () => {
    const { backend, mail } = twoAccountBackend();
    const drafts = createFakeMailDrafts(backend);
    const first = await saveComposeDraft(drafts, writtenNew(), aliases);
    const moved = await saveComposeDraft(drafts, { ...first, fromAddress: "work@example.com" }, aliases);

    expect(moved.draft).toMatchObject({ id: "draft-2", mailboxId: "mailbox-work", from: "work@example.com" });
    expect(mail.discarded).toEqual(["draft-1"]);
    expect(mail.drafts.map((draft) => draft.id)).toEqual(["draft-2"]);
  });

  it("recreates a reply from its source in the other account, then writes the window into it", async () => {
    const { backend, mail } = twoAccountBackend();
    const drafts = createFakeMailDrafts(backend);
    const reply = await startReplyCompose(drafts, {
      mode: "reply",
      message: { ...message({}), id: "email-1" },
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });
    const moved = await saveComposeDraft(drafts, { ...reply, fromAddress: "work@example.com", body: "Sure." }, aliases);

    expect(mail.calls.map((call) => call.kind)).toEqual(["create", "create", "update", "discard"]);
    expect(mail.calls[1]).toEqual({
      kind: "create",
      request: { mailboxId: "mailbox-work", mode: "reply", sourceEmailId: "email-1", body: "" },
    });
    expect(moved.draft).toMatchObject({
      mailboxId: "mailbox-work",
      mode: "reply",
      sourceEmailId: "email-1",
      threadId: "thread-invoice",
      from: "work@example.com",
      body: "Sure.",
    });
    expect(mail.discarded).toEqual(["draft-1"]);
  });
});

describe("sending", () => {
  it("creates the draft and sends it when nothing was saved yet", async () => {
    const backend = createMailboxBackend();
    const sent = await sendCompose(createFakeMailDrafts(backend), writtenNew(), aliases);

    expect(backend.mail?.calls.map((call) => call.kind)).toEqual(["create", "send"]);
    expect(sent.status).toBe("sent");
  });

  it("writes the pending edits onto the saved draft before sending it", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const saved = await saveComposeDraft(drafts, writtenNew(), aliases);
    await sendCompose(drafts, { ...saved, body: "Final words" }, aliases);

    expect(backend.mail?.calls.map((call) => call.kind)).toEqual(["create", "update", "send"]);
    expect(backend.mail?.sent.map((draft) => [draft.id, draft.body])).toEqual([["draft-1", "Final words"]]);
  });

  it("sends a saved draft without an update when nothing changed", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const saved = await saveComposeDraft(drafts, writtenNew(), aliases);
    await sendCompose(drafts, saved, aliases);

    expect(backend.mail?.calls.map((call) => call.kind)).toEqual(["create", "send"]);
  });

  it("keeps the draft and reports the backend's message when the send is refused", async () => {
    const backend = createMailboxBackend();
    if (backend.mail) backend.mail.rejectSend = "The SMTP server refused the login";
    const refused = await sendCompose(createFakeMailDrafts(backend), writtenNew(), aliases);

    expect(refused.status).toBe("editing");
    expect(refused.error).toEqual({ kind: "failed", message: "The SMTP server refused the login" });
    expect(refused.draft?.id).toBe("draft-1");
    expect(refused.kept).toBe(true);
    expect(backend.mail?.drafts.map((draft) => draft.id)).toEqual(["draft-1"]);
  });

  it("refuses to send with no recipient, without calling the backend", async () => {
    const backend = createMailboxBackend();
    const refused = await sendCompose(createFakeMailDrafts(backend), newCompose(PRIMARY_ADDRESS), aliases);

    expect(refused.error).toEqual({ kind: "invalid", problem: "noRecipients" });
    expect(backend.mail?.calls).toEqual([]);
  });
});

describe("replying", () => {
  it("opens on the draft the backend created from the source message", async () => {
    const backend = createMailboxBackend();
    const reply = await startReplyCompose(createFakeMailDrafts(backend), {
      mode: "replyAll",
      message: { ...message({}), id: "email-1" },
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });

    expect(backend.mail?.calls).toEqual([
      {
        kind: "create",
        request: { mailboxId: MAILBOX_ITEM_ID, mode: "replyAll", sourceEmailId: "email-1", body: "" },
      },
    ]);
    expect(reply).toMatchObject({
      mode: "replyAll",
      fromAddress: ALIAS_ADDRESS,
      to: "Billing <billing@example.com>, Ada <ada@example.com>, books@example.com",
      subject: "Re: Invoice for March",
      body: "\n\nOn 2 March 2026, Billing wrote:\n> Attached.",
      kept: false,
    });
  });

  it("builds the reply locally when the backend has no metadata for the message", async () => {
    const legacy = message({
      name: "Lunch?",
      sender: "Friend <friend@example.com>",
      recipients: "me@example.com, Bob <bob@example.com>",
      body: "Thursday?",
    });
    const reply = await startReplyCompose(createFakeMailDrafts(createMailboxBackend()), {
      mode: "replyAll",
      message: legacy,
      aliases,
      attribution: "Friend wrote:",
      mailboxItemId: MAILBOX_ITEM_ID,
    });

    expect(reply).toMatchObject({
      draft: null,
      fromAddress: "me@example.com",
      to: "Friend <friend@example.com>, Bob <bob@example.com>",
      subject: "Re: Lunch?",
      body: "\n\nFriend wrote:\n> Thursday?\n",
    });
  });

  it("propagates a refusal other than a missing source", async () => {
    // No mail module at all: the draft routes answer 501.
    await expect(
      startReplyCompose(createFakeMailDrafts({ items: [], relations: [], views: [] }), {
        mode: "reply",
        message: message({}),
        aliases,
        attribution: "",
        mailboxItemId: MAILBOX_ITEM_ID,
      }),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("addresses only the sender of a local plain reply", () => {
    const reply = localReplyCompose({
      mode: "reply",
      message: message({ sender: "friend@example.com", recipients: "bob@example.com" }),
      aliases,
      attribution: "",
    });
    expect(reply.to).toBe("friend@example.com");
  });
});

describe("switching a reply between Reply and Reply to all", () => {
  const source = { ...message({}), id: "email-1" };

  it("takes the other mode's recipients from a new draft and discards the replaced one, keeping what was typed", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const reply = await startReplyCompose(drafts, {
      mode: "reply",
      message: source,
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });
    const switched = await switchReplyMode(
      drafts,
      { ...reply, body: `On it. ${reply.body}` },
      { mode: "replyAll", message: source, aliases, attribution: "" },
    );

    expect(switched).toMatchObject({
      mode: "replyAll",
      to: "Billing <billing@example.com>, Ada <ada@example.com>, books@example.com",
      draft: { id: "draft-2", mode: "replyAll" },
      kept: false,
    });
    expect(switched.body.startsWith("On it. ")).toBe(true);
    expect(backend.mail?.discarded).toEqual(["draft-1"]);
    // An unkept reply is not written again until the user saves or sends.
    expect(backend.mail?.calls.map((call) => call.kind)).toEqual(["create", "create", "discard"]);
  });

  it("writes a kept reply's content into the replacement at once", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const reply = await startReplyCompose(drafts, {
      mode: "reply",
      message: source,
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });
    const saved = await saveComposeDraft(drafts, { ...reply, body: "Saved text" }, aliases);
    const switched = await switchReplyMode(drafts, saved, {
      mode: "replyAll",
      message: source,
      aliases,
      attribution: "",
    });

    expect(switched.kept).toBe(true);
    expect(backend.mail?.drafts.map((draft) => [draft.id, draft.mode, draft.body])).toEqual([
      ["draft-2", "replyAll", "Saved text"],
    ]);
  });

  it("recomputes the recipients of a locally built reply without calling the backend", async () => {
    const backend = createMailboxBackend();
    const legacy = message({ sender: "friend@example.com", recipients: "me@example.com, bob@example.com" });
    const local = localReplyCompose({ mode: "reply", message: legacy, aliases, attribution: "" });
    const switched = await switchReplyMode(createFakeMailDrafts(backend), local, {
      mode: "replyAll",
      message: legacy,
      aliases,
      attribution: "",
    });

    expect(switched.to).toBe("friend@example.com, bob@example.com");
    expect(backend.mail?.calls).toEqual([]);
  });
});

describe("closing", () => {
  it("discards a started reply the user never kept", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const reply = await startReplyCompose(drafts, {
      mode: "reply",
      message: { ...message({}), id: "email-1" },
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });

    await expect(closeCompose(drafts, reply)).resolves.toBeNull();
    expect(backend.mail?.discarded).toEqual(["draft-1"]);
  });

  it("keeps a saved draft", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const saved = await saveComposeDraft(drafts, writtenNew(), aliases);

    await expect(closeCompose(drafts, saved)).resolves.toBeNull();
    expect(backend.mail?.discarded).toEqual([]);
  });

  it("closes when the draft is already gone", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const reply = await startReplyCompose(drafts, {
      mode: "reply",
      message: { ...message({}), id: "email-1" },
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });
    await drafts.discard("draft-1");

    await expect(closeCompose(drafts, reply)).resolves.toBeNull();
  });

  it("stays open with the refusal when the discard fails", async () => {
    const backend = createMailboxBackend();
    const drafts = createFakeMailDrafts(backend);
    const reply = await startReplyCompose(drafts, {
      mode: "reply",
      message: { ...message({}), id: "email-1" },
      aliases,
      attribution: "",
      mailboxItemId: MAILBOX_ITEM_ID,
    });
    const refusing = { ...drafts, discard: async () => Promise.reject(new Error("The server is unreachable")) };

    await expect(closeCompose(refusing, reply)).resolves.toMatchObject({
      error: { kind: "failed", message: "The server is unreachable" },
      draft: { id: "draft-1" },
    });
  });
});
