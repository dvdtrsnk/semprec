import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "@semprec/shared";
import { assertKnownValue } from "../dbRowValidation.js";
import type { SempReplyStep, SempReplyStepParams, SempReplyStepStatus, SempReplyStepText } from "./sempReplySteps.js";
import { sempUuid } from "./sempReplyToolCalls.js";

/**
 * Reads `semp_messages.steps` back as the steps `projectSempReplySteps` wrote (issue #1887). The column is
 * `jsonb`, so a value that a hand-written backfill or a later migration left in another shape is checked here
 * instead of cast: it throws `Malformed semp_messages.steps in database row`, or, for a step kind or status
 * outside the known set, `Unknown step kind in database row` / `Unknown step status in database row`.
 */

const STEP_KINDS = ["tool", "model"] as const;
const STEP_STATUSES: readonly SempReplyStepStatus[] = ["ok", "wait", "error"];

function malformed(): never {
  throw new Error("Malformed semp_messages.steps in database row");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value : malformed();
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireString(value);
}

/** A list entry of a step's params: a property key, or a change `{ key, before?, after? }` of a property. */
function isParamListEntry(value: unknown): boolean {
  return typeof value === "string" || (isRecord(value) && typeof value.key === "string");
}

function isParamValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isParamListEntry))
  );
}

function parseText(value: unknown): SempReplyStepText {
  if (!isRecord(value) || !isRecord(value.params) || !Object.values(value.params).every(isParamValue)) malformed();
  // The checks above are the whole of `SempReplyStepParams`; the compiler cannot narrow a record's values.
  return { key: requireString(value.key), params: value.params as SempReplyStepParams };
}

function parseTokens(value: unknown): { input: number; output: number } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return malformed();
  const { input, output } = value;
  if (typeof input !== "number" || typeof output !== "number") return malformed();
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return malformed();
  return { input, output };
}

function parseOperation(value: unknown): GenericOperationName | undefined {
  const name = optionalString(value);
  if (name === undefined) return undefined;
  return GENERIC_OPERATION_NAMES.find((known) => known === name) ?? malformed();
}

function parseApprovalRequestId(value: unknown): string | undefined {
  const id = optionalString(value);
  if (id === undefined) return undefined;
  return sempUuid(id) === id ? id : malformed();
}

function parseStep(value: unknown): SempReplyStep {
  if (!isRecord(value)) return malformed();
  const { durationMs } = value;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return malformed();
  const toolCallId = optionalString(value.toolCallId);
  const toolName = optionalString(value.toolName);
  const operation = parseOperation(value.operation);
  const approvalRequestId = parseApprovalRequestId(value.approvalRequestId);
  const errorCode = optionalString(value.errorCode);
  const tokens = parseTokens(value.tokens);
  return {
    kind: assertKnownValue(STEP_KINDS, requireString(value.kind), "step kind"),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(operation === undefined ? {} : { operation }),
    label: parseText(value.label),
    detail: parseText(value.detail),
    status: assertKnownValue(STEP_STATUSES, requireString(value.status), "step status"),
    startedAt: requireString(value.startedAt),
    durationMs,
    ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/** The steps stored in a `semp_messages.steps` column; `undefined` for a `null` column (a reply with no stored summary). */
export function parseStoredSempReplySteps(value: unknown): SempReplyStep[] | undefined {
  if (value === null) return undefined;
  return Array.isArray(value) ? (value as unknown[]).map(parseStep) : malformed();
}
