// The body of an `approval_pending` notification (issue #1773). It is rendered once, at write time,
// from the request's description snapshot (issue #1683): the body catalog entry for the description's
// key, filled with the description's params. Nothing else reaches the body. An MCP call's argument
// values are not in its description, so they cannot reach the body either.
//
// Generic operation metadata determines Semp's undo capability. MCP calls have no Semp undo.
import { GENERIC_OPERATION_NAMES, OPERATION_METADATA } from "@semprec/shared";
import { isGenericOperationApprovalRequestPayload, type ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import type { WriteNotificationInput } from "./notify.js";

/** Body catalog key per description key (`notifications/i18n/{cs,en}.json`, `notification.approval_pending.body.*`). */
const BODY_KEY_BY_DESCRIPTION_KEY = new Map<string, string>([
  ["approval.itemDelete", "approval.itemDelete"],
  ["approval.itemPatch", "approval.itemPatch"],
  ["approval.propertyDelete", "approval.propertyDelete"],
  ["approval.databaseArchive", "approval.databaseArchive"],
  ["approval.viewDelete", "approval.viewDelete"],
  ["approval.relationDelete", "approval.relationDelete"],
  ["approval.relationPut", "approval.relationPut"],
  ["approval.relationSet", "approval.relationSet"],
  ["approval.pageRestore", "approval.pageRestore"],
  ["approval.mcpInvoke", "approval.mcpInvoke"],
]);

/**
 * The body fields of a `writeNotification` call for an approval request. A request without a
 * description (a row written before issue #1683) gets no body, so its notification's body stays NULL.
 * A description key with no body entry is a producer bug and throws, which rolls back the request
 * and its notification together rather than storing an approval whose notification has no text.
 */
export function approvalNotificationBody(
  request: Pick<ApprovalRequest, "description" | "payload" | "riskClass">,
): Pick<WriteNotificationInput, "bodyKey" | "bodyParams" | "bodySuffixKey"> {
  const { description } = request;
  if (description === null) return {};
  const bodyKey = BODY_KEY_BY_DESCRIPTION_KEY.get(description.key);
  if (bodyKey === undefined) {
    throw new Error(`approvalNotificationBody: no body entry for approval description "${description.key}"`);
  }
  const operationName = isGenericOperationApprovalRequestPayload(request.payload)
    ? request.payload.operationName
    : undefined;
  const operation = GENERIC_OPERATION_NAMES.find((name) => name === operationName);
  const reversible = operation !== undefined && OPERATION_METADATA[operation].reversible;
  return {
    bodyKey,
    bodyParams: description.params,
    bodySuffixKey: reversible ? "notification.body.canUndo" : "notification.body.cannotUndo",
  };
}
