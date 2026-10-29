// The body of an `approval_pending` notification (issue #1773). It is rendered once, at write time,
// from the request's description snapshot (issue #1683): the body catalog entry for the description's
// key, filled with the description's params. Nothing else reaches the body. An MCP call's argument
// values are not in its description, so they cannot reach the body either.
//
// Each body entry ends with the reversibility sentence of its action, and that sentence is fixed by the
// entry: it cannot differ between two requests with the same description key. The undo sentence goes
// with the generic operations flagged `reversible` in `OPERATION_METADATA` (issue #1730): `item.delete`,
// `database.archive` and `page.restoreVersion`. `approvalNotificationBody.unit.test.ts` checks each entry
// against that flag. Every other action is irreversible, including every MCP call, because Semp has no
// undo for an external tool and a sentence promising one would be a false promise.
import type { ApprovalDescription } from "../mcp/approvalRequestsStore.js";
import type { WriteNotificationInput } from "./notify.js";

/** Body catalog key per description key (`notifications/i18n/{cs,en}.json`, `notification.approval_pending.body.*`). */
const BODY_KEY_BY_DESCRIPTION_KEY = new Map<string, string>([
  ["approval.itemDelete", "notification.approval_pending.body.itemDelete"],
  ["approval.propertyDelete", "notification.approval_pending.body.propertyDelete"],
  ["approval.databaseArchive", "notification.approval_pending.body.databaseArchive"],
  ["approval.viewDelete", "notification.approval_pending.body.viewDelete"],
  ["approval.relationDelete", "notification.approval_pending.body.relationDelete"],
  ["approval.pageRestore", "notification.approval_pending.body.pageRestore"],
  ["approval.mcpInvoke", "notification.approval_pending.body.mcpInvoke"],
]);

/**
 * The body fields of a `writeNotification` call for an approval request. A request without a
 * description (a row written before issue #1683) gets no body, so its notification's body stays NULL.
 * A description key with no body entry is a producer bug and throws, which rolls back the request
 * and its notification together rather than storing an approval whose notification has no text.
 */
export function approvalNotificationBody(
  description: ApprovalDescription | null,
): Pick<WriteNotificationInput, "bodyKey" | "bodyParams"> {
  if (description === null) return {};
  const bodyKey = BODY_KEY_BY_DESCRIPTION_KEY.get(description.key);
  if (bodyKey === undefined) {
    throw new Error(`approvalNotificationBody: no body entry for approval description "${description.key}"`);
  }
  return { bodyKey, bodyParams: description.params };
}
