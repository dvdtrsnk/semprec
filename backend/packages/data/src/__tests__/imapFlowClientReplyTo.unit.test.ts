import type { FetchMessageObject, ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import type { FetchedMessage } from "../mail/providerTypes.js";

function parse(envelope: object): Promise<FetchedMessage> {
  const client = new ImapFlowMailClient({} as ImapFlow) as unknown as {
    parseFetchedMessage(raw: FetchMessageObject): Promise<FetchedMessage>;
  };
  return client.parseFetchedMessage({ uid: 1, envelope, headers: Buffer.from("") } as unknown as FetchMessageObject);
}

describe("IMAP Reply-To envelope", () => {
  it("stores the ImapFlow replyTo addresses", async () => {
    const fetched = await parse({
      from: [{ name: "Sender", address: "sender@example.test" }],
      replyTo: [{ name: "Support", address: "support@example.test" }],
    });
    expect(fetched.envelope.replyTo).toEqual([{ name: "Support", address: "support@example.test" }]);
  });

  it("leaves replyTo absent when the message has none", async () => {
    const fetched = await parse({ from: [{ name: "Sender", address: "sender@example.test" }] });
    expect(fetched.envelope).not.toHaveProperty("replyTo");
  });
});
