import { ImapFlow, type AppendResponseObject } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";

/** The deadline `ImapFlowMailClient.appendMessage` waits for the server to answer APPEND (imapFlowClient.ts). */
const APPEND_TIMEOUT_MS = 60_000;

const raw = Buffer.from("From: me@mail.test\r\nMessage-ID: <one@mail.test>\r\n\r\nhi bob\r\n", "utf8");

/** An `ImapFlowMailClient` over a stub connection whose `append` records its arguments and answers as `append` does. */
function clientWith(append: () => Promise<AppendResponseObject | false>) {
  const calls: unknown[][] = [];
  const connection = new ImapFlow({
    host: "unused.example.test",
    port: 993,
    secure: true,
    auth: { user: "unused", pass: "unused" },
    logger: false,
  });
  vi.spyOn(connection, "append").mockImplementation(async (...args) => {
    calls.push(args);
    return append();
  });
  return { client: new ImapFlowMailClient(connection), calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImapFlowMailClient.appendMessage (issue #1641)", () => {
  it("appends the same bytes to the folder with the given flags, and resolves when the server answers", async () => {
    const { client, calls } = clientWith(async () => ({ destination: "Sent Items", uid: 7 }));

    await expect(client.appendMessage("Sent Items", raw, ["\\Seen"])).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const [path, content, flags] = calls[0] ?? [];
    expect(path).toBe("Sent Items");
    expect(content).toBe(raw);
    expect(flags).toEqual(["\\Seen"]);
  });

  it("rejects safely when APPEND did not run", async () => {
    const { client, calls } = clientWith(async () => false);
    await expect(client.appendMessage("Sent Items", raw, ["\\Seen"])).rejects.toThrow(
      "IMAP provider operation failed unexpectedly",
    );
    expect(calls).toHaveLength(1);
  });

  it("rejects a server refusal with a fixed safe provider error", async () => {
    const secret = "APPEND-PRIVATE-SENTINEL";
    const refusal = Object.assign(new Error(secret), {
      name: secret,
      code: secret,
      responseStatus: "NO",
      cause: new Error(secret),
    });
    let observed: unknown;
    const { client, calls } = clientWith(async () => {
      observed = refusal;
      throw refusal;
    });
    const outcome = await client.appendMessage("Sent Items", raw, ["\\Seen"]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(observed).toBe(refusal);
    expect(calls).toHaveLength(1);
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Missing APPEND refusal");
    expect(outcome).not.toBe(refusal);
    expect(outcome.name).toBe("Error");
    expect(outcome.message).toBe("IMAP provider operation failed unexpectedly");
    expect(outcome).not.toHaveProperty("cause");
    expect(outcome).not.toHaveProperty("responseStatus");
    expect(outcome).not.toHaveProperty("code");
    expect(Object.keys(outcome)).toEqual([]);
    expect(`${outcome.name} ${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain(secret);
  });

  it("clears its deadline timer once the server has answered", async () => {
    vi.useFakeTimers();
    const { client } = clientWith(async () => ({ destination: "Sent Items", uid: 7 }));

    await client.appendMessage("Sent Items", raw, ["\\Seen"]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects once the deadline passes without an answer, and not before", async () => {
    vi.useFakeTimers();
    const { client } = clientWith(() => new Promise<AppendResponseObject | false>(() => undefined));

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
