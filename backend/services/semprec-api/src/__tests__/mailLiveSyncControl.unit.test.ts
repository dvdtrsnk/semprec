import { describe, expect, it } from "vitest";
import { CustomRouteConfigurationError } from "../adapter/customRouteMount.js";
import { createMailLiveSyncControl } from "../mailLiveSyncControl.js";

/** The rejection of `promise`, failing when it resolves or rejects with something that is no `Error`. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error("expected a rejection");
}

describe("the custom routes' mail live-sync control (issue gh-1742)", () => {
  it("forwards restartAccount to the root it was bound to", async () => {
    const restarted: string[] = [];
    const binding = createMailLiveSyncControl();
    binding.bind({
      async restartAccount(mailboxItemId) {
        restarted.push(mailboxItemId);
      },
    });

    await binding.control.restartAccount("mailbox-1");

    expect(restarted).toEqual(["mailbox-1"]);
  });

  it("passes the root's rejection on unchanged", async () => {
    const failure = new Error("the restart failed");
    const binding = createMailLiveSyncControl();
    binding.bind({
      async restartAccount() {
        throw failure;
      },
    });

    expect(await caught(binding.control.restartAccount("mailbox-1"))).toBe(failure);
  });

  it("refuses restartAccount with a configuration error that names it while no root is bound", async () => {
    const error = await caught(createMailLiveSyncControl().control.restartAccount("mailbox-1"));

    expect(error).toBeInstanceOf(CustomRouteConfigurationError);
    expect(error.message).toBe(
      'custom route dependency "mailLiveSync.restartAccount" was called before the mail live-sync root exists',
    );
  });

  it.each([
    ["startMailbox", 'custom route dependency "mailLiveSync.startMailbox" is not wired in this composition root yet'],
    ["stopMailbox", 'custom route dependency "mailLiveSync.stopMailbox" is not wired in this composition root yet'],
  ] as const)("refuses %s with a configuration error that names it, bound or not", async (method, message) => {
    const binding = createMailLiveSyncControl();
    const unbound = await caught(binding.control[method]("tenant-1", "mailbox-1"));
    binding.bind({ async restartAccount() {} });
    const bound = await caught(binding.control[method]("tenant-1", "mailbox-1"));

    for (const error of [unbound, bound]) {
      expect(error).toBeInstanceOf(CustomRouteConfigurationError);
      expect(error.message).toBe(message);
    }
  });
});
