import { describe, expect, it } from "vitest";
import { formatAddressList, parseAddressList } from "../addresses.js";
import { aliasOptions, composePayload, defaultFromAddress, newCompose, replyRecipients, replySubject, type AliasOption } from "../compose.js";
import type { MessageEnvelope } from "../mailOperations.js";

const aliases: AliasOption[] = [
  { address: "me@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
  { address: "alias@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
  { address: "work@example.com", mailboxItemId: "mailbox-work", mailboxName: "Work" },
];

const envelope: MessageEnvelope["envelope"] = {
  from: { name: "Ada", address: "ada@example.com" },
  to: [{ address: "alias@example.com" }, { name: "Bob", address: "bob@example.com" }],
  cc: [{ address: "cara@example.com" }, { address: "bob@example.com" }],
  bcc: [],
};

const selfAddresses = aliases.map((alias) => alias.address);

describe("compose recipients (issue #98)", () => {
  it("keeps a quoted display name that contains the separator as one address", () => {
    expect(parseAddressList('"Doe, John" <john@example.com>, ada@example.com')).toEqual([
      { name: "Doe, John", address: "john@example.com" },
      { address: "ada@example.com" },
    ]);
  });

  it("drops a repeated address, however it is written", () => {
    expect(parseAddressList("Ada <ada@example.com>\nADA@example.com")).toEqual([{ name: "Ada", address: "ada@example.com" }]);
  });

  it("replies to the sender alone", () => {
    expect(replyRecipients(envelope, "reply", selfAddresses)).toEqual({ to: [{ name: "Ada", address: "ada@example.com" }], cc: [] });
  });

  it("replies to all from the structured envelope, dropping the user's own aliases and repeated addresses", () => {
    const { to, cc } = replyRecipients(envelope, "replyAll", selfAddresses);
    // `alias@example.com` is this user; `bob@example.com` is both a To and a Cc of the original.
    expect(formatAddressList(to)).toBe("Ada <ada@example.com>, Bob <bob@example.com>");
    expect(formatAddressList(cc)).toBe("cara@example.com");
  });

  it("answers the recipients of a message the user sent themselves, not the user", () => {
    const own: MessageEnvelope["envelope"] = { from: { address: "me@example.com" }, to: [{ address: "ada@example.com" }], cc: [], bcc: [] };
    expect(replyRecipients(own, "reply", selfAddresses)).toEqual({ to: [{ address: "ada@example.com" }], cc: [] });
  });

  it("prefixes the subject once", () => {
    expect(replySubject("Invoice")).toBe("Re: Invoice");
    expect(replySubject("RE: Invoice")).toBe("RE: Invoice");
  });
});

describe("compose sender (issue #98)", () => {
  it("reads the registered aliases off the mailboxes, keeping their order", () => {
    const options = aliasOptions([
      { id: "mailbox-personal", databaseId: "db", properties: { name: "Personal", addresses: "me@example.com\nalias@example.com" }, computed: {}, updatedAt: "", deletedAt: null },
    ]);
    expect(options).toEqual([
      { address: "me@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
      { address: "alias@example.com", mailboxItemId: "mailbox-personal", mailboxName: "Personal" },
    ]);
  });

  it("defaults to the alias the replied-to message was delivered to", () => {
    expect(defaultFromAddress({ aliases, deliveredToAddress: "ALIAS@example.com", contextMailboxItemId: "mailbox-work" })).toBe("alias@example.com");
  });

  it("falls back to the account context when the delivered-to alias is not one of the registered ones", () => {
    expect(defaultFromAddress({ aliases, deliveredToAddress: "someone@elsewhere.test", contextMailboxItemId: "mailbox-work" })).toBe("work@example.com");
  });

  it("falls back to the primary address when there is no context either", () => {
    expect(defaultFromAddress({ aliases })).toBe("me@example.com");
  });
});

describe("compose payload (issue #98)", () => {
  it("sends from the mailbox the chosen alias belongs to", () => {
    const state = { ...newCompose("work@example.com"), to: "ada@example.com", subject: "Hi" };
    const result = composePayload(state, aliases, { requireRecipients: true });
    expect(result).toEqual({
      ok: true,
      payload: {
        mailboxItemId: "mailbox-work",
        subject: "Hi",
        from: { address: "work@example.com" },
        to: [{ address: "ada@example.com" }],
        cc: [],
        bcc: [],
        bodyText: "",
        inReplyTo: null,
        references: [],
      },
    });
  });

  it("refuses to send without a recipient, but saves a draft that has none", () => {
    const state = newCompose("me@example.com");
    expect(composePayload(state, aliases, { requireRecipients: true })).toEqual({ ok: false, problem: "noRecipients" });
    expect(composePayload(state, aliases, { requireRecipients: false }).ok).toBe(true);
  });

  it("refuses an address that is not a registered alias", () => {
    expect(composePayload({ ...newCompose("nobody@example.com"), to: "ada@example.com" }, aliases, { requireRecipients: true })).toEqual({
      ok: false,
      problem: "noSender",
    });
  });
});
