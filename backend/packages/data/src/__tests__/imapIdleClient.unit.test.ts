import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createImapFlowIdleTransport,
  IMAP_IDLE_MAX_IDLE_TIME_MS,
  IMAP_IDLE_SOCKET_TIMEOUT_MS,
  type CreateIdleTunedImapFlowClient,
} from "../mail/imapIdleClient.js";

/**
 * Just enough of imapflow's `ImapFlow` surface for this transport (list/connect/mailboxOpen/logout/close + the three
 * events it wires) — a real socket is never involved. The factory hands it over already connected, as
 * `openImapFlow` does, so `connectCalls` stays 0 unless the transport connects it itself, which it must not.
 */
class FakeImapFlow extends EventEmitter {
  connectCalls = 0;
  logoutCalls = 0;
  openedMailbox: string | undefined;
  listResult: Array<{ path: string; specialUse?: string }> = [];
  /** Simulates a final server push (e.g. an EXISTS) arriving during logout, right before BYE/close. */
  emitOnLogout: string | undefined;

  async connect(): Promise<void> {
    this.connectCalls++;
  }

  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    return this.listResult;
  }

  async mailboxOpen(path: string): Promise<void> {
    this.openedMailbox = path;
  }

  async logout(): Promise<void> {
    this.logoutCalls++;
    if (this.emitOnLogout) this.emit(this.emitOnLogout, {});
    this.emit("close");
  }

  close(): void {
    this.emit("close");
  }
}

function makeFactory(clients: FakeImapFlow[]): {
  createClient: CreateIdleTunedImapFlowClient;
  idleOptionsSeen: Array<{ maxIdleTime: number; socketTimeout: number }>;
} {
  let index = 0;
  const idleOptionsSeen: Array<{ maxIdleTime: number; socketTimeout: number }> = [];
  const createClient: CreateIdleTunedImapFlowClient = async (_mailboxItemId, _credential, idleOptions) => {
    idleOptionsSeen.push(idleOptions);
    const client = clients[index++];
    if (!client) throw new Error("no more fake clients configured");
    return client as unknown as import("imapflow").ImapFlow;
  };
  return { createClient, idleOptionsSeen };
}

describe("imapflow-backed IDLE transport (issue #196)", () => {
  it("renews well under 29 minutes and bounds the socket timeout", async () => {
    expect(IMAP_IDLE_MAX_IDLE_TIME_MS).toBeLessThan(29 * 60 * 1000);
    expect(IMAP_IDLE_SOCKET_TIMEOUT_MS).toBeGreaterThan(IMAP_IDLE_MAX_IDLE_TIME_MS);
  });

  it("resolves Inbox and the All-Mail-equivalent folder by special-use, ignoring every other folder", async () => {
    const client = new FakeImapFlow();
    client.listResult = [
      { path: "Sent", specialUse: "\\Sent" },
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "[Gmail]/All Mail", specialUse: "\\All" },
      { path: "Trash", specialUse: "\\Trash" },
    ];
    const { createClient, idleOptionsSeen } = makeFactory([client]);
    const transport = createImapFlowIdleTransport(createClient);

    const folders = await transport.resolveFolders("mailbox-1", "cred");

    expect(folders.map((f) => f.path).sort()).toEqual(["INBOX", "[Gmail]/All Mail"].sort());
    expect(client.connectCalls).toBe(0); // the client arrives connected; the transport never connects it.
    expect(client.logoutCalls).toBe(1); // resolveFolders' own connection is always released, not left open.
    expect(idleOptionsSeen[0]).toEqual({
      maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS,
      socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS,
    });
  });

  it("falls back to plain INBOX when the server advertises neither \\Inbox nor \\All", async () => {
    const client = new FakeImapFlow();
    client.listResult = [{ path: "INBOX" }, { path: "Archive" }];
    const { createClient } = makeFactory([client]);
    const transport = createImapFlowIdleTransport(createClient);

    const folders = await transport.resolveFolders("mailbox-1", "cred");

    expect(folders).toEqual([{ path: "INBOX" }]);
  });

  it("connects, selects the folder, and turns EXISTS/EXPUNGE/flags into onSignal calls", async () => {
    const client = new FakeImapFlow();
    const { createClient } = makeFactory([client]);
    const transport = createImapFlowIdleTransport(createClient);

    let signals = 0;
    const connection = await transport.connect("mailbox-1", "cred", "INBOX", () => signals++);

    expect(client.openedMailbox).toBe("INBOX");
    expect(client.connectCalls).toBe(0); // the client arrives connected; the transport never connects it.
    client.emit("exists", {});
    client.emit("expunge", {});
    client.emit("flags", {});
    expect(signals).toBe(3);

    const ended = connection.waitForEnd();
    await connection.close();
    await expect(ended).resolves.toBeUndefined();
    expect(client.logoutCalls).toBe(1);
  });

  it("no longer invokes onSignal for a signal the server emits during logout, after close() has resolved", async () => {
    const client = new FakeImapFlow();
    client.emitOnLogout = "exists";
    const { createClient } = makeFactory([client]);
    const transport = createImapFlowIdleTransport(createClient);

    let signals = 0;
    const connection = await transport.connect("mailbox-1", "cred", "INBOX", () => signals++);

    await connection.close();

    expect(signals).toBe(0);
  });

  it("waitForEnd resolves with the error when the connection fails, and close() afterward is a harmless no-op", async () => {
    const client = new FakeImapFlow();
    const { createClient } = makeFactory([client]);
    const transport = createImapFlowIdleTransport(createClient);

    const connection = await transport.connect("mailbox-1", "cred", "INBOX", () => {});
    const boom = new Error("socket reset");
    const ended = connection.waitForEnd();
    client.emit("error", boom);

    await expect(ended).resolves.toBe(boom);
    await expect(connection.close()).resolves.toBeUndefined();
  });
  it("retains the original discovery and cleanup failures in order", async () => {
    const client = new FakeImapFlow();
    const original = new Error("private discovery failure");
    const cleanup = new Error("private logout failure");
    client.list = async () => {
      throw original;
    };
    client.logout = async () => {
      throw cleanup;
    };
    const transport = createImapFlowIdleTransport(makeFactory([client]).createClient);
    let observed: unknown;
    try {
      await transport.resolveFolders("mailbox-1", "credential");
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("expected aggregate");
    expect(observed.errors).toEqual([original, cleanup]);
  });
  it("detaches end listeners even when logout returns without a close event", async () => {
    const client = new FakeImapFlow();
    client.logout = async () => {};
    const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
      "mailbox-1",
      "cred",
      "INBOX",
      () => {},
    );
    await connection.close();
    await expect(connection.waitForEnd()).resolves.toBeUndefined();
    expect(client.listenerCount("close")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });
  it("forces a stalled logout closed and joins its actual rejection", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeImapFlow();
      const lateFailure = new Error("private logout rejection");
      let rejectLogout!: (error: unknown) => void;
      client.logout = () =>
        new Promise((_resolve, reject) => {
          rejectLogout = reject;
        });
      client.close = () => {
        rejectLogout(lateFailure);
        client.emit("close");
      };
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "cred",
        "INBOX",
        () => {},
      );
      const outcome = connection.close().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("expected aggregate");
      expect(error.errors).toHaveLength(2);
      expect(error.errors[1]).toBe(lateFailure);
      expect(client.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("distinguishes an error event carrying undefined from a clean close", async () => {
    const client = new FakeImapFlow();
    const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
      "mailbox-1",
      "cred",
      "INBOX",
      () => {},
    );
    const ended = connection.waitForEnd();
    client.emit("error", undefined);
    await expect(ended).resolves.toEqual({ failure: undefined });
    await connection.close();
  });
});
