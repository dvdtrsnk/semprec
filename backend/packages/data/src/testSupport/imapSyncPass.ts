import type { ImapSyncPass } from "../mail/imapReconcile.js";

/** A pass that takes no mailbox guard and schedules nothing, for tests that call `reconcileImapAccount` directly. */
export const UNGUARDED_IMAP_PASS: ImapSyncPass = {
  enter: async () => true,
  finish: async () => {},
};
