import type { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import { logger } from "../mail/logger.js";

/** The LOGOUT deadline `ImapFlowMailClient.close()` waits for before it closes the socket without an answer. */
const LOGOUT_TIMEOUT_MS = 10_000;

interface ConnectionBehaviour {
  logout: () => Promise<void>;
  close?: () => void;
}

/** An `ImapFlowMailClient` over a stub connection that counts the LOGOUT and close calls it receives. */
function clientWith(behaviour: ConnectionBehaviour) {
  const calls = { logout: 0, close: 0 };
  const connection = {
    logout: () => {
      calls.logout += 1;
      return behaviour.logout();
    },
    close: () => {
      calls.close += 1;
      behaviour.close?.();
    },
  };
  // The stub implements only the two methods close() uses, the same way the other unit tests of this client do.
  return { client: new ImapFlowMailClient(connection as unknown as ImapFlow), calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImapFlowMailClient.close (issue #1510)", () => {
  it("logs out and closes the socket when the server answers LOGOUT", async () => {
    const { client, calls } = clientWith({ logout: async () => undefined });

    await expect(client.close()).resolves.toBeUndefined();

    expect(calls).toEqual({ logout: 1, close: 1 });
  });

  it("still closes the socket when LOGOUT fails and logs only a fixed stage", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { client, calls } = clientWith({
      logout: async () => {
        throw new Error("LOGIN password app-password-leak-check");
      },
    });

    await expect(client.close()).resolves.toBeUndefined();

    expect(calls.close).toBe(1);
    expect(warn).toHaveBeenCalledWith({ stage: "logout" }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("app-password-leak-check");
  });

  it("closes the socket once the LOGOUT deadline passes without an answer", async () => {
    vi.useFakeTimers();
    const { client, calls } = clientWith({ logout: () => new Promise<void>(() => undefined) });

    const closing = client.close();
    await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 1);
    expect(calls.close).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    await expect(closing).resolves.toBeUndefined();
    expect(calls.close).toBe(1);
  });

  it("still resolves when closing the socket throws and logs only a fixed stage", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { client, calls } = clientWith({
      logout: async () => undefined,
      close: () => {
        throw new Error("socket already destroyed");
      },
    });

    await expect(client.close()).resolves.toBeUndefined();

    expect(calls.close).toBe(1);
    expect(warn).toHaveBeenCalledWith({ stage: "close" }, expect.any(String));
  });

  it("still closes when the logout diagnostic itself fails", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("password sentinel");
    });
    const { client, calls } = clientWith({
      logout: async () => {
        throw new Error("password sentinel");
      },
    });
    await expect(client.close()).resolves.toBeUndefined();
    expect(calls.close).toBe(1);
  });
});
