import type { ImapSessionPool, MailLiveSyncRoot } from "@semprec/data";
import { CustomRouteConfigurationError, type MailLiveSyncControl } from "./adapter/customRouteMount.js";

type ControlledMailLiveSyncRoot = Pick<MailLiveSyncRoot, "restartAccount" | "stopMailbox">;

export interface MailLiveSyncControlBinding {
  control: MailLiveSyncControl;
  /** Called once the composition root has created the root. */
  bind(root: ControlledMailLiveSyncRoot): void;
}

/**
 * The composition root creates the live-sync root after the request dispatcher, so the dispatcher
 * gets this control first and the root is bound afterwards.
 *
 * `restartAccount` and `stopMailbox` forward to the bound root, and then close the account's kept
 * IMAP sync session (`imapSessions`), hosted or not: both follow a replaced sign-in, Mail switched
 * off or a removal. Before binding, both refuse with a configuration error (a generic 500 through
 * the adapter; the removed-mailbox cleanup reports it as a failed step). `startMailbox` always
 * refuses: the root has no single-mailbox start.
 */
export function createMailLiveSyncControl(
  imapSessions: Pick<ImapSessionPool, "closeAccount">,
): MailLiveSyncControlBinding {
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
        try {
          await boundRoot.stopMailbox(tenantId, mailboxItemId);
        } finally {
          await imapSessions.closeAccount(mailboxItemId);
        }
      },
      async restartAccount(mailboxItemId) {
        if (boundRoot === undefined) {
          throw new CustomRouteConfigurationError(
            'custom route dependency "mailLiveSync.restartAccount" was called before the mail live-sync root exists',
          );
        }
        try {
          await boundRoot.restartAccount(mailboxItemId);
        } finally {
          await imapSessions.closeAccount(mailboxItemId);
        }
      },
    },
    bind(root) {
      boundRoot = root;
    },
  };
}
