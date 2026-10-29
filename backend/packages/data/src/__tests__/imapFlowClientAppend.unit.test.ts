import type { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";

/** The deadline `ImapFlowMailClient.appendMessage` waits for the server to answer APPEND (imapFlowClient.ts). */
const APPEND_TIMEOUT_MS = 60_000;

const raw = Buffer.from("From: me@mail.test\r\nMessage-ID: <one@mail.test>\r\n\r\nhi bob\r\n", "utf8");

/** An `ImapFlowMailClient` over a stub connection whose `append` records its arguments and answers as `append` does. */
function clientWith(append: () => Promise<unknown>) {
  const calls: unknown[][] = [];
  const connection = {
    append: (...args: unknown[]) => {
      calls.push(args);
      return append();
    },
  };
  // The stub implements only the one method appendMessage() uses, the same way the other unit tests of this client do.
  return { client: new ImapFlowMailClient(connection as unknown as ImapFlow), calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImapFlowMailClient.appendMessage (issue #1641)", () => {
  it("appends the same bytes to the folder with the given flags, and resolves when the server answers", async () => {
    const { client, calls } = clientWith(async () => ({ path: "Sent Items", uid: 7 }));

    await expect(client.appendMessage("Sent Items", raw, ["\\Seen"])).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const [path, content, flags] = calls[0] ?? [];
    expect(path).toBe("Sent Items");
    expect(content).toBe(raw);
    expect(flags).toEqual(["\\Seen"]);
  });

  it("rejects with the server's refusal itself, so a refused append is not reported as a success", async () => {
    const refusal = Object.assign(new Error("Mailbox does not exist"), { responseStatus: "NO" });
    const { client } = clientWith(async () => {
      throw refusal;
    });

    await expect(client.appendMessage("Sent Items", raw, ["\\Seen"])).rejects.toBe(refusal);
  });

  it("clears its deadline timer once the server has answered", async () => {
    vi.useFakeTimers();
    const { client } = clientWith(async () => ({ path: "Sent Items", uid: 7 }));

    await client.appendMessage("Sent Items", raw, ["\\Seen"]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects once the deadline passes without an answer, and not before", async () => {
    vi.useFakeTimers();
    const { client } = clientWith(() => new Promise<unknown>(() => undefined));

    let outcome: unknown = "pending";
    client.appendMessage("Sent Items", raw, ["\\Seen"]).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(APPEND_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(new Error(`IMAP append timed out after ${APPEND_TIMEOUT_MS}ms`));
  });
});
