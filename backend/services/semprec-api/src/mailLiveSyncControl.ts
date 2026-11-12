import type { MailLiveSyncRoot } from "@semprec/data";
import { CustomRouteConfigurationError, type MailLiveSyncControl } from "./adapter/customRouteMount.js";

/** The part of the mail live-sync root the custom routes reach through their `mailLiveSync` member. */
type ControlledMailLiveSyncRoot = Pick<MailLiveSyncRoot, "restartAccount" | "stopMailbox">;

export interface MailLiveSyncControlBinding {
  /** The member the composition root puts into the custom-route dependencies. */
  control: MailLiveSyncControl;
  /** Connects `control` to the live-sync root, once the composition root has created it. */
  bind(root: ControlledMailLiveSyncRoot): void;
}

/**
 * The custom routes' control of the mail live-sync root (issue gh-1742). The composition root creates
 * the root after the request dispatcher, so the dispatcher gets this control first and the root is
 * bound to it afterwards (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md).
 *
 * `restartAccount` forwards to the bound root's `restartAccount`, and `stopMailbox` (issue gh-2030)
 * to its `stopMailbox`; each settles as the root's call does. Called before a root is bound, either
 * refuses with a configuration error. The adapter answers that error with a generic 500 when a route
 * lets it through; the cleanup of a removed mailbox reports it as a failed step instead. `startMailbox`
 * refuses the same way on every call: the root has no start of one mailbox to forward to.
 */
export function createMailLiveSyncControl(): MailLiveSyncControlBinding {
  let boundRoot: ControlledMailLiveSyncRoot | undefined;
  return {
    control: {
      async startMailbox() {
        throw new CustomRouteConfigurationError(
          'custom route dependency "mailLiveSync.startMailbox" is not wired in this composition root yet',
        );
      },
      async stopMailbox(tenantId, mailboxItemId) {
        if (boundRoot === undefined) {
          throw new CustomRouteConfigurationError(
            'custom route dependency "mailLiveSync.stopMailbox" was called before the mail live-sync root exists',
          );
        }
        await boundRoot.stopMailbox(tenantId, mailboxItemId);
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
