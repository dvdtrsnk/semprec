// Rendered once at write time from the request's description snapshot only, so MCP argument
// values can never reach the body. MCP calls have no Semp undo.
import { GENERIC_OPERATION_NAMES, OPERATION_METADATA, PAGE_CONVERT_TARGET_TYPES } from "@alldots/shared";
import { isGenericOperationApprovalRequestPayload, type ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalPeriods.js";
import { ITEM_DELETE_IMPACT_BODY_KEY, type WriteNotificationInput } from "./notify.js";

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

/** The impact variant only when the description carries all three impact counts to fill it. */
function itemDeleteBodyKey(params: Readonly<Record<string, string | number | null>>): string {
  const carriesImpact = [params.seriesInstanceCount, params.attachmentCount, params.hostEventCount].every(
    (count) => typeof count === "number",
  );
  return carriesImpact ? ITEM_DELETE_IMPACT_BODY_KEY : "approval.itemDelete";
}

/** One entry per period type so the user sees a localised word, never the canonical key. */
function journalMergeBodyKey(params: Readonly<Record<string, string | number | null>>): string {
  const type = JOURNAL_PERIOD_TYPES.find((candidate) => candidate === params.periodType);
  if (type === undefined) throw new Error("approvalNotificationBody: unknown Journal period type in the description");
  return `approval.journalMerge.${type}`;
}

/** One entry per block type so the user sees a localised phrase, never the canonical key. */
function pageConvertBodyKey(params: Readonly<Record<string, string | number | null>>): string {
  const type = PAGE_CONVERT_TARGET_TYPES.find((candidate) => candidate === params.blockType);
  if (type === undefined) throw new Error("approvalNotificationBody: unknown block type in the description");
  return `approval.pageConvertToBlock.${type}`;
}

/**
 * A request without a description gets a NULL body. An unmapped description key is a producer bug
 * and throws, rolling back the request with its notification rather than storing one without text.
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
