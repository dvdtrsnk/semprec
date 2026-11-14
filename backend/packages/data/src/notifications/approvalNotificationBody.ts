// The body of an `approval_pending` notification (issue #1773). It is rendered once, at write time,
// from the request's description snapshot (issue #1683): the body catalog entry for the description's
// key, filled with the description's params. Nothing else reaches the body. An MCP call's argument
// values are not in its description, so they cannot reach the body either.
//
// Generic operation metadata determines Semp's undo capability. MCP calls have no Semp undo.
import { GENERIC_OPERATION_NAMES, OPERATION_METADATA, PAGE_CONVERT_TARGET_TYPES } from "@semprec/shared";
import { isGenericOperationApprovalRequestPayload, type ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalPeriods.js";
import { ITEM_DELETE_IMPACT_BODY_KEY, type WriteNotificationInput } from "./notify.js";

/** Body catalog key per description key (`notifications/i18n/{cs,en}.json`, `notification.approval_pending.body.*`). */
const BODY_KEY_BY_DESCRIPTION_KEY = new Map<string, string>([
  ["approval.itemDelete", "approval.itemDelete"],
  ["approval.itemPatch", "approval.itemPatch"],
  ["approval.changesSeries", "approval.changesSeries"],
  ["approval.breaksLink", "approval.breaksLink"],
  ["approval.propertyDelete", "approval.propertyDelete"],
  ["approval.databaseArchive", "approval.databaseArchive"],
  ["approval.viewDelete", "approval.viewDelete"],
  ["approval.relationDelete", "approval.relationDelete"],
  ["approval.relationPut", "approval.relationPut"],
  ["approval.relationSet", "approval.relationSet"],
  ["approval.pageRestore", "approval.pageRestore"],
  ["approval.pageReplace", "approval.pageReplace"],
  ["approval.mcpInvoke", "approval.mcpInvoke"],
  ["approval.moduleTool", "approval.moduleTool"],
  ["approval.emailSend", "approval.emailSend"],
  ["approval.heartbeatCreate", "approval.heartbeatCreate"],
  ["approval.heartbeatUpdate", "approval.heartbeatUpdate"],
  ["approval.heartbeatSetEnabled", "approval.heartbeatSetEnabled"],
]);

/**
 * The body catalog key of an item delete: `approval.itemDeleteImpact` for a description that carries the delete impact of
 * the item's module (issue gh-1882: the instances of its series, its attachments and the events it is placed in), so the
 * approver is told what the snapshot covers, and `approval.itemDelete` for every other item, whose description has no
 * such counts to fill the placeholders of the first.
 */
function itemDeleteBodyKey(params: Readonly<Record<string, string | number | null>>): string {
  const carriesImpact = [params.seriesInstanceCount, params.attachmentCount, params.hostEventCount].every(
    (count) => typeof count === "number",
  );
  return carriesImpact ? ITEM_DELETE_IMPACT_BODY_KEY : "approval.itemDelete";
}

/**
 * The body catalog key of a Journal merge: one entry per period type (`approval.journalMerge.<type>`), so the period
 * type reaches the user as a localised word and never as the canonical key stored in the description (issue #2017).
 * The stored params stay canonical; the entries name only `{period}` and the two titles.
 */
function journalMergeBodyKey(params: Readonly<Record<string, string | number | null>>): string {
  const type = JOURNAL_PERIOD_TYPES.find((candidate) => candidate === params.periodType);
  if (type === undefined) throw new Error("approvalNotificationBody: unknown Journal period type in the description");
  return `approval.journalMerge.${type}`;
}

/**
 * The body catalog key of a page conversion: one entry per target block type (`approval.pageConvertToBlock.<type>`), so
 * the block type reaches the user as a localised phrase and never as the canonical key stored in the description
 * (issue #1876). The entries name `{pageName}` and `{pageCount}`.
 */
function pageConvertBodyKey(params: Readonly<Record<string, string | number | null>>): string {
  const type = PAGE_CONVERT_TARGET_TYPES.find((candidate) => candidate === params.blockType);
  if (type === undefined) throw new Error("approvalNotificationBody: unknown block type in the description");
  return `approval.pageConvertToBlock.${type}`;
}

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
  const bodyKey =
    description.key === "approval.journalMerge"
      ? journalMergeBodyKey(description.params)
      : description.key === "approval.pageConvertToBlock"
        ? pageConvertBodyKey(description.params)
        : description.key === "approval.itemDelete"
          ? itemDeleteBodyKey(description.params)
          : BODY_KEY_BY_DESCRIPTION_KEY.get(description.key);
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
