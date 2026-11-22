import type { MailSyncPass } from "../mail/mailSyncPass.js";

/** A pass that takes no mailbox guard and schedules nothing, for tests that call an account reconcile directly. */
export const UNGUARDED_MAIL_SYNC_PASS: MailSyncPass = {
  enter: async () => true,
  finish: async () => {},
};
