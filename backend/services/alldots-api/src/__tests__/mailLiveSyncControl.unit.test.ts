import { describe, expect, it } from "vitest";
import { CustomRouteConfigurationError } from "../adapter/customRouteMount.js";
import { createMailLiveSyncControl } from "../mailLiveSyncControl.js";

const noKeptSessions = { closeAccount: async () => {} };

/** Fails when `promise` resolves or rejects with a non-`Error`. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error("expected a rejection");
}

describe("the custom routes' mail live-sync control (issues gh-1742 and gh-2030)", () => {
  it("forwards restartAccount to the root it was bound to", async () => {
    const restarted: string[] = [];
    const stopped: string[][] = [];
    const binding = createMailLiveSyncControl(noKeptSessions);
    binding.bind({
      async restartAccount(mailboxItemId) {
        restarted.push(mailboxItemId);
      },
      async stopMailbox(tenantId, mailboxItemId) {
        stopped.push([tenantId, mailboxItemId]);
      },
    });

    await binding.control.restartAccount("mailbox-1");

    expect(restarted).toEqual(["mailbox-1"]);
    expect(stopped).toEqual([]);
  });

  it("passes the root's rejection of a restart on unchanged", async () => {
    const failure = new Error("the restart failed");
    const binding = createMailLiveSyncControl(noKeptSessions);
    binding.bind({
      async restartAccount() {
        throw failure;
      },
      async stopMailbox() {},
    });

    expect(await caught(binding.control.restartAccount("mailbox-1"))).toBe(failure);
  });

  it("forwards stopMailbox, with the tenant and the mailbox, to the root it was bound to", async () => {
    const restarted: string[] = [];
    const stopped: string[][] = [];
    const binding = createMailLiveSyncControl(noKeptSessions);
    binding.bind({
      async restartAccount(mailboxItemId) {
        restarted.push(mailboxItemId);
      },
      async stopMailbox(tenantId, mailboxItemId) {
        stopped.push([tenantId, mailboxItemId]);
      },
    });

    await binding.control.stopMailbox("tenant-1", "mailbox-1");

    expect(stopped).toEqual([["tenant-1", "mailbox-1"]]);
    expect(restarted).toEqual([]);
  });

  it("passes the root's rejection of a stop on unchanged", async () => {
    const failure = new Error("the stop failed");
    const binding = createMailLiveSyncControl(noKeptSessions);
    binding.bind({
      async restartAccount() {},
      async stopMailbox() {
        throw failure;
      },
    });

    expect(await caught(binding.control.stopMailbox("tenant-1", "mailbox-1"))).toBe(failure);
  });

  it("refuses stopMailbox with a configuration error that names it while no root is bound", async () => {
    const error = await caught(createMailLiveSyncControl(noKeptSessions).control.stopMailbox("tenant-1", "mailbox-1"));

    expect(error).toBeInstanceOf(CustomRouteConfigurationError);
    expect(error.message).toBe(
      'custom route dependency "mailLiveSync.stopMailbox" was called before the mail live-sync root exists',
    );
  });

  it("refuses restartAccount with a configuration error that names it while no root is bound", async () => {
    const error = await caught(createMailLiveSyncControl(noKeptSessions).control.restartAccount("mailbox-1"));

    expect(error).toBeInstanceOf(CustomRouteConfigurationError);
    expect(error.message).toBe(
      'custom route dependency "mailLiveSync.restartAccount" was called before the mail live-sync root exists',
    );
  });

  it("refuses startMailbox with a configuration error that names it, bound or not", async () => {
    const stopped: string[][] = [];
    const binding = createMailLiveSyncControl(noKeptSessions);
    const unbound = await caught(binding.control.startMailbox("tenant-1", "mailbox-1"));
    binding.bind({
      async restartAccount() {},
      async stopMailbox(tenantId, mailboxItemId) {
        stopped.push([tenantId, mailboxItemId]);
      },
    });
    const bound = await caught(binding.control.startMailbox("tenant-1", "mailbox-1"));

    for (const error of [unbound, bound]) {
      expect(error).toBeInstanceOf(CustomRouteConfigurationError);
      expect(error.message).toBe(
        'custom route dependency "mailLiveSync.startMailbox" is not wired in this composition root yet',
      );
    }
    expect(stopped).toEqual([]);
  });

  it.each(["restartAccount", "stopMailbox"] as const)(
    "closes the account's kept IMAP sync session after %s, also when the root refuses it",
    async (call) => {
      const events: string[] = [];
      const failure = new Error("the root refused");
      const binding = createMailLiveSyncControl({
        async closeAccount(mailboxItemId) {
          events.push(`closeAccount:${mailboxItemId}`);
        },
      });
      let refuse = false;
      binding.bind({
        async restartAccount(mailboxItemId) {
          events.push(`restartAccount:${mailboxItemId}`);
          if (refuse) throw failure;
        },
        async stopMailbox(_tenantId, mailboxItemId) {
          events.push(`stopMailbox:${mailboxItemId}`);
          if (refuse) throw failure;
        },
      });
      const run = () =>
        call === "restartAccount"
          ? binding.control.restartAccount("mailbox-1")
          : binding.control.stopMailbox("tenant-1", "mailbox-1");

      await run();
      refuse = true;
      expect(await caught(run())).toBe(failure);

      expect(events).toEqual([
        `${call}:mailbox-1`,
        "closeAccount:mailbox-1",
        `${call}:mailbox-1`,
        "closeAccount:mailbox-1",
      ]);
    },
  );
});
