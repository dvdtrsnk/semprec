// A mailbox leaves only through its removal, which also deletes its credential and sync rows and cleans
// up at the provider, so a generic trash by a user or agent is refused.
import type { ItemDeleteApprovalGuard, ItemDeleteHook } from "../chokePoint/hooks.js";
import type { WriterKind } from "../chokePoint/writerKind.js";
import { ForbiddenError } from "../errors.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import type { DatabaseRow } from "../types.js";

/**
 * Refuses a `user` or `agent` trash of a row of the tenant's system Mailboxes database. The `system`
 * writer (used by `removeMailbox`) passes, as does any other database.
 */
function mailboxDeleteRefusal(database: DatabaseRow, itemId: string, writerKind: WriterKind): string | null {
  if (!database.system || database.ownerModuleId !== MAILBOXES_MODULE_ID) return null;
  if (writerKind === "system") return null;
  return `Mailbox ${itemId} cannot be deleted as an item; it is removed through DELETE /api/mail/mailboxes/:id`;
}

/** A refusal is a 403 `forbidden`, which rolls the whole trash cascade back. */
export const mailboxDeleteHook: ItemDeleteHook = async ({ database, item, writerKind }) => {
  const refusal = mailboxDeleteRefusal(database, item.id, writerKind);
  if (refusal !== null) throw new ForbiddenError(refusal);
};

/** Refuses an agent's `item.delete` before an approval request is created, not only at execution. */
export const mailboxDeleteApprovalGuard: ItemDeleteApprovalGuard = async ({ database, item }) =>
  mailboxDeleteRefusal(database, item.id, "agent");
