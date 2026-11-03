import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createImapFlowIdleTransport,
  IMAP_IDLE_MAX_IDLE_TIME_MS,
  IMAP_IDLE_SOCKET_TIMEOUT_MS,
  type CreateIdleTunedImapFlowClient,
} from "../mail/imapIdleClient.js";
import { logger } from "../mail/logger.js";

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

  async logout(): Promise<boolean | void> {
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
  it("retains separately observed discovery error and rejection even when the same object is reused", async () => {
    const client = new FakeImapFlow();
    const shared = new Error("private discovery failure");
    client.list = async () => {
      client.emit("error", shared);
      throw shared;
    };
    let observed: unknown;
    try {
      await createImapFlowIdleTransport(makeFactory([client]).createClient).resolveFolders("mailbox-1", "credential");
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("expected separate observations");
    expect(observed.errors).toEqual([shared, shared]);
  });
  it("retains a later distinct error event even when it reuses the first error object", async () => {
    const client = new FakeImapFlow();
    const shared = new Error("private reused error");
    client.logout = async () => false;
    client.close = () => {};
    const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
      "mailbox-1",
      "credential",
      "INBOX",
      () => {},
    );
    const ended = connection.waitForEnd();
    client.emit("error", shared);
    expect(await ended).toBe(shared);
    const cleanup = connection.close().catch((error: unknown) => error);
    try {
      client.emit("error", shared);
      client.emit("close");
      expect(await cleanup).toBe(shared);
    } finally {
      client.emit("close");
      await cleanup;
    }
  });
  it("retains a close-time error event before a separate synchronous close failure", async () => {
    const client = new FakeImapFlow();
    const original = new Error("private original");
    const eventFailure = new Error("private event failure");
    const closeFailure = new Error("private close failure");
    client.logout = async () => false;
    client.close = () => {
      client.emit("error", eventFailure);
      throw closeFailure;
    };
    const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
      "mailbox-1",
      "credential",
      "INBOX",
      () => {},
    );
    const ended = connection.waitForEnd();
    client.emit("error", original);
    expect(await ended).toBe(original);
    const pending = connection.close().catch((error: unknown) => error);
    try {
      await Promise.resolve();
      await Promise.resolve();
      client.emit("close");
      const cleanup = await pending;
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("expected ordered cleanup errors");
      expect(cleanup.errors).toEqual([eventFailure, closeFailure]);
    } finally {
      client.emit("close");
      await pending;
    }
  });
  it("keeps ownership until the public close event after logout returns", async () => {
    const client = new FakeImapFlow();
    client.logout = async () => {};
    const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
      "mailbox-1",
      "cred",
      "INBOX",
      () => {},
    );
    let settled = false;
    const closing = connection.close().then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      client.emit("close");
      await closing;
      await expect(connection.waitForEnd()).resolves.toBeUndefined();
      expect(client.listenerCount("close")).toBe(0);
      expect(client.listenerCount("error")).toBe(0);
    } finally {
      client.emit("close");
      await closing;
    }
  });
  it("forces a stalled logout closed and joins its actual rejection", async () => {
    vi.useFakeTimers();
    const client = new FakeImapFlow();
    const lateFailure = new Error("private logout rejection");
    let rejectLogout: (error: unknown) => void = () => {};
    let outcome: Promise<unknown> | undefined;
    try {
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
      outcome = connection.close().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("expected aggregate");
      expect(error.errors).toHaveLength(2);
      expect(error.errors[0]).toBe(lateFailure);
      expect(client.listenerCount("close")).toBe(0);
    } finally {
      rejectLogout(lateFailure);
      client.emit("close");
      if (outcome) await outcome;
      vi.useRealTimers();
    }
  });
  it("treats a false public logout as ambiguous and requests close with a fixed diagnostic", async () => {
    const client = new FakeImapFlow();
    client.logout = async () => false;
    const close = vi.spyOn(client, "close");
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "private-folder",
        () => {},
      );
      await connection.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        { stage: "logout", category: "ambiguous" },
        "IMAP IDLE provider cleanup observation",
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-folder");
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps stop pending after public close until the actual logout settles", async () => {
    vi.useFakeTimers();
    const client = new FakeImapFlow();
    let release: () => void = () => {};
    let pending: Promise<unknown> | undefined;
    try {
      client.logout = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const close = vi.spyOn(client, "close");
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "INBOX",
        () => {},
      );
      let settled = false;
      pending = connection
        .close()
        .catch((error: unknown) => error)
        .then((error) => {
          settled = true;
          return error;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      release();
      expect(await pending).toBeInstanceOf(Error);
      expect(settled).toBe(true);
    } finally {
      release();
      client.emit("close");
      if (pending) await pending;
      vi.useRealTimers();
    }
  });
  it("diagnoses a false logout received after timeout without releasing pending close observation", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const client = new FakeImapFlow();
    let releaseLogout: (value: boolean) => void = () => {};
    let pending: Promise<unknown> | undefined;
    try {
      client.logout = () =>
        new Promise<boolean>((resolve) => {
          releaseLogout = resolve;
        });
      client.close = () => {};
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "private-folder",
        () => {},
      );
      let settled = false;
      pending = connection
        .close()
        .catch((error: unknown) => error)
        .then((error) => {
          settled = true;
          return error;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      releaseLogout(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(warning.mock.calls.map((call) => call[0])).toEqual([
        { stage: "logout", category: "unresolved" },
        { stage: "logout", category: "ambiguous" },
      ]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-folder");
      client.emit("close");
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      releaseLogout(false);
      client.emit("close");
      if (pending) await pending;
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
  it("waits for a public close after false logout and reuses an already observed close", async () => {
    for (const alreadyClosed of [false, true]) {
      const client = new FakeImapFlow();
      client.logout = async () => false;
      client.close = () => {};
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "INBOX",
        () => {},
      );
      if (alreadyClosed) client.emit("close");
      let settled = false;
      const pending = connection.close().then(() => {
        settled = true;
      });
      try {
        await Promise.resolve();
        await Promise.resolve();
        if (!alreadyClosed) {
          expect(settled).toBe(false);
          client.emit("close");
        }
        await pending;
        expect(settled).toBe(true);
      } finally {
        client.emit("close");
        await pending;
      }
    }
  });
  it("uses the same grace deadline when logout succeeds but public close is still absent", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const client = new FakeImapFlow();
    let pending: Promise<unknown> | undefined;
    try {
      client.logout = async () => true;
      const close = vi.spyOn(client, "close").mockImplementation(() => {});
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "INBOX",
        () => {},
      );
      let settled = false;
      pending = connection
        .close()
        .catch((error: unknown) => error)
        .then((error) => {
          settled = true;
          return error;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(warning.mock.calls.map((call) => call[0])).toEqual([{ stage: "logout", category: "unresolved" }]);
      client.emit("close");
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      client.emit("close");
      if (pending) await pending;
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
  it("retains diagnostic and synchronous close failures while waiting for the public end", async () => {
    const client = new FakeImapFlow();
    const diagnostic = new Error("private diagnostic failure");
    const closeFailure = new Error("private close failure");
    client.logout = async () => false;
    client.close = () => {
      throw closeFailure;
    };
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw diagnostic;
    });
    let pending: Promise<unknown> | undefined;
    try {
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "INBOX",
        () => {},
      );
      let settled = false;
      pending = connection
        .close()
        .catch((error: unknown) => error)
        .then((error) => {
          settled = true;
          return error;
        });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      client.emit("close");
      const error = await pending;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("expected cleanup failures");
      expect(error.errors).toEqual([diagnostic, closeFailure]);
    } finally {
      client.emit("close");
      if (pending) await pending;
      warning.mockRestore();
    }
  });
  it("retains an undefined logout rejection before its timeout and close failure", async () => {
    vi.useFakeTimers();
    const client = new FakeImapFlow();
    let rejectLogout: (error: unknown) => void = () => {};
    let pending: Promise<unknown> | undefined;
    try {
      client.logout = () =>
        new Promise((_resolve, reject) => {
          rejectLogout = reject;
        });
      const closeFailure = new Error("private close failure");
      client.close = () => {
        throw closeFailure;
      };
      const connection = await createImapFlowIdleTransport(makeFactory([client]).createClient).connect(
        "mailbox-1",
        "credential",
        "INBOX",
        () => {},
      );
      pending = connection.close().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      rejectLogout(undefined);
      client.emit("close");
      const error = await pending;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("expected ordered cleanup failures");
      expect(error.errors[0]).toBeUndefined();
      expect(error.errors[1]).toBeInstanceOf(Error);
      expect(error.errors[2]).toBe(closeFailure);
    } finally {
      rejectLogout(undefined);
      client.emit("close");
      if (pending) await pending;
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
