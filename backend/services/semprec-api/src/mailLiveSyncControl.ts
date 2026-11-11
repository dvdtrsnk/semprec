import type { MailLiveSyncRoot } from "@semprec/data";
import { CustomRouteConfigurationError, type MailLiveSyncControl } from "./adapter/customRouteMount.js";

export interface MailLiveSyncControlBinding {
  /** The member the composition root puts into the custom-route dependencies. */
  control: MailLiveSyncControl;
  /** Connects `control` to the live-sync root, once the composition root has created it. */
  bind(root: Pick<MailLiveSyncRoot, "restartAccount">): void;
}

/**
 * The custom routes' control of the mail live-sync root (issue gh-1742). The composition root creates
 * the root after the request dispatcher, so the dispatcher gets this control first and the root is
 * bound to it afterwards (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md).
 *
 * `restartAccount` forwards to the bound root's `restartAccount`. Called before a root is bound it
 * refuses with a configuration error, which the adapter answers with a generic 500. `startMailbox`
 * and `stopMailbox` refuse the same way on every call: the root has no start or stop of one mailbox
 * to forward to.
 */
export function createMailLiveSyncControl(): MailLiveSyncControlBinding {
  let boundRoot: Pick<MailLiveSyncRoot, "restartAccount"> | undefined;
  return {
    control: {
      async startMailbox() {
        throw new CustomRouteConfigurationError(
          'custom route dependency "mailLiveSync.startMailbox" is not wired in this composition root yet',
        );
      },
      async stopMailbox() {
        throw new CustomRouteConfigurationError(
          'custom route dependency "mailLiveSync.stopMailbox" is not wired in this composition root yet',
        );
      },
      async restartAccount(mailboxItemId) {
        if (boundRoot === undefined) {
          throw new CustomRouteConfigurationError(
            'custom route dependency "mailLiveSync.restartAccount" was called before the mail live-sync root exists',
          );
        }
        await boundRoot.restartAccount(mailboxItemId);
      },
    },
    bind(root) {
      boundRoot = root;
    },
  };
}
