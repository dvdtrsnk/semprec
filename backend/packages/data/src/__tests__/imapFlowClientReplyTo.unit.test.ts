import type { FetchMessageObject, ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import type { ImapMessageEnvelope } from "../mail/imapReconcile.js";

function parse(envelope: object): ImapMessageEnvelope {
  const client = new ImapFlowMailClient({} as ImapFlow) as unknown as {
    parseFetchedMessage(path: string, raw: FetchMessageObject): { message: ImapMessageEnvelope };
  };
  return client.parseFetchedMessage("INBOX", {
    uid: 1,
    envelope,
    headers: Buffer.from(""),
  } as unknown as FetchMessageObject).message;
}

describe("IMAP Reply-To envelope", () => {
  it("stores the ImapFlow replyTo addresses", () => {
    const fetched = parse({
      from: [{ name: "Sender", address: "sender@example.test" }],
      replyTo: [{ name: "Support", address: "support@example.test" }],
    });
    expect(fetched.envelope.replyTo).toEqual([{ name: "Support", address: "support@example.test" }]);
  });

  it("leaves replyTo absent when the message has none", () => {
    const fetched = parse({ from: [{ name: "Sender", address: "sender@example.test" }] });
    expect(fetched.envelope).not.toHaveProperty("replyTo");
  });
});
