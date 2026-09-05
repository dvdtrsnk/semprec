import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createImapFlowIdleTransport, IMAP_IDLE_MAX_IDLE_TIME_MS, IMAP_IDLE_SOCKET_TIMEOUT_MS, type CreateIdleTunedImapFlowClient } from "../mail/imapIdleClient.js";

/** Just enough of imapflow's `ImapFlow` surface for this transport (list/connect/mailboxOpen/logout/close + the three events it wires) — a real socket is never involved. */
class FakeImapFlow extends EventEmitter {
  connectCalls = 0;
  logoutCalls = 0;
  openedMailbox: string | undefined;
  listResult: Array<{ path: string; specialUse?: string }> = [];

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
    this.emit("close");
  }

  close(): void {
    this.emit("close");
  }
}

function makeFactory(clients: FakeImapFlow[]): { createClient: CreateIdleTunedImapFlowClient; idleOptionsSeen: Array<{ maxIdleTime: number; socketTimeout: number }> } {
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
    expect(client.logoutCalls).toBe(1); // resolveFolders' own connection is always released, not left open.
    expect(idleOptionsSeen[0]).toEqual({ maxIdleTime: IMAP_IDLE_MAX_IDLE_TIME_MS, socketTimeout: IMAP_IDLE_SOCKET_TIMEOUT_MS });
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
    client.emit("exists", {});
    client.emit("expunge", {});
    client.emit("flags", {});
    expect(signals).toBe(3);

    const ended = connection.waitForEnd();
    await connection.close();
    await expect(ended).resolves.toBeUndefined();
    expect(client.logoutCalls).toBe(1);
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
});
