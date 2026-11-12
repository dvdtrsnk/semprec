// Refuses a generic trash of a Mailboxes item (issue gh-2031), so that a mailbox leaves only through
// its removal, which also deletes its credential and sync rows and cleans up at the provider.
// Constrained by: docs/adr/2026-11-11-a-mailboxes-item-is-trashed-only-by-the-system-writer.md
import type { ItemDeleteApprovalGuard, ItemDeleteHook } from "../chokePoint/hooks.js";
import type { WriterKind } from "../chokePoint/writerKind.js";
import { ForbiddenError } from "../errors.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import type { DatabaseRow } from "../types.js";

/**
 * The one rule both exports below apply: the message a trash of item `itemId` of `database` by a
 * writer of kind `writerKind` is refused with, or `null` when it is not refused.
 *
 * The Mailboxes database is the tenant's system database of the `mailboxes` module, as `removeMailbox`
 * finds it (`mail/mailboxRemoval.ts`). A row of that database trashed by a `user` or an `agent` writer
 * is refused. A row trashed by the `system` writer passes: that is the writer `removeMailbox` trashes
 * the mailbox with. A row of any other database passes whoever trashes it, a database that carries the
 * module id without being a system database included.
 */
function mailboxDeleteRefusal(database: DatabaseRow, itemId: string, writerKind: WriterKind): string | null {
  if (!database.system || database.ownerModuleId !== MAILBOXES_MODULE_ID) return null;
  if (writerKind === "system") return null;
  return `Mailbox ${itemId} cannot be deleted as an item; it is removed through DELETE /api/mail/mailboxes/:id`;
}

/**
 * The item delete hook of the Mailboxes database. A refused trash (`mailboxDeleteRefusal`) rejects
 * with a 403 `forbidden` error, which rolls the whole trash cascade back.
 *
 * The generic REST route and the `/mcp` operation derive their writer from the caller's identity
 * (`writerIdentityOf` in `@semprec/application`), which answers `user` or `agent`, and the executor of
 * an approved request writes as `agent` (`replayApprovedGenericOperation`).
 */
export const mailboxDeleteHook: ItemDeleteHook = async ({ database, item, writerKind }) => {
  const refusal = mailboxDeleteRefusal(database, item.id, writerKind);
  if (refusal !== null) throw new ForbiddenError(refusal);
};

/**
 * The same refusal for the approval projection of `item.delete`, which only an agent run reaches: its
 * request for a Mailboxes item is answered 403 `forbidden` before an approval request is created,
 * where the hook above would refuse the approved request only when it is executed.
 */
export const mailboxDeleteApprovalGuard: ItemDeleteApprovalGuard = async ({ database, item }) =>
  mailboxDeleteRefusal(database, item.id, "agent");
