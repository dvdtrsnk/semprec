import { describe, expect, it } from "vitest";
import {
  deriveReplyOutcome,
  REPLY_INCOMPLETE_REASONS,
  replyOutcomeOfStoredSteps,
  type ReplyOutcomeStep,
} from "../replyOutcome.js";

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SERVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REGISTRATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_REGISTRATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ok: ReplyOutcomeStep = { status: "ok", operation: "item.get", toolName: "item_get" };
const failedOperation: ReplyOutcomeStep = {
  status: "error",
  operation: "item.patch",
  toolName: "item_patch",
  errorCode: "validation_error",
};
const mcpOk: ReplyOutcomeStep = {
  status: "ok",
  toolName: "mcp_search_aaaaaaaa",
  mcpToolRegistrationId: REGISTRATION,
};
const mcpTimeout: ReplyOutcomeStep = {
  status: "error",
  toolName: "mcp_search_aaaaaaaa",
  errorCode: "timeout",
  mcpToolRegistrationId: REGISTRATION,
  mcpServerItemId: SERVER,
  connectorName: "GitHub",
  timeoutMs: 60000,
};

describe("deriveReplyOutcome (issue #1890)", () => {
  it("exports the three reasons as a constant", () => {
    expect(REPLY_INCOMPLETE_REASONS).toEqual(["toolTimeout", "toolUnavailable", "toolError"]);
  });

  it("is complete for a reply without steps, for one with only successful steps and for one that waits for approval", () => {
    expect(deriveReplyOutcome([])).toEqual({ outcome: "complete" });
    expect(deriveReplyOutcome([ok, mcpOk])).toEqual({ outcome: "complete" });
    expect(deriveReplyOutcome([ok, { status: "wait", operation: "item.delete", toolName: "item_delete" }])).toEqual({
      outcome: "complete",
    });
  });

  it("is incomplete with toolTimeout, the server and the stored timeout for an MCP call that timed out", () => {
    expect(deriveReplyOutcome([ok, mcpTimeout, { status: "ok", toolName: "other" }])).toEqual({
      outcome: "incomplete",
      incompleteReason: "toolTimeout",
      mcpServerItemId: SERVER,
      connectorName: "GitHub",
      timeoutMs: 60000,
    });
  });

  it("reads the seconds from the stored timeout and not from a constant", () => {
    const reply = deriveReplyOutcome([{ ...mcpTimeout, timeoutMs: 15000 }]);
    expect(reply).toMatchObject({ incompleteReason: "toolTimeout", timeoutMs: 15000 });
  });

  it("gives toolUnavailable for an unavailable MCP call, with no server when the registration was not resolved", () => {
    const unavailable: ReplyOutcomeStep = {
      status: "error",
      toolName: "mcp_search_aaaaaaaa",
      errorCode: "unavailable",
      connectorName: "GitHub",
    };
    expect(deriveReplyOutcome([unavailable])).toEqual({
      outcome: "incomplete",
      incompleteReason: "toolUnavailable",
      connectorName: "GitHub",
    });
    expect(deriveReplyOutcome([{ ...unavailable, mcpServerItemId: SERVER }])).toMatchObject({
      incompleteReason: "toolUnavailable",
      mcpServerItemId: SERVER,
    });
  });

  it.each(["connection", "auth", "toolError"])("gives toolError for an MCP call that failed with %s", (errorCode) => {
    expect(deriveReplyOutcome([{ ...mcpTimeout, errorCode, timeoutMs: undefined }])).toEqual({
      outcome: "incomplete",
      incompleteReason: "toolError",
      mcpServerItemId: SERVER,
      connectorName: "GitHub",
    });
  });

  it("does not report a timeout for a call that failed with another kind even when a timeout is stored on the step", () => {
    const reply = deriveReplyOutcome([{ ...mcpTimeout, errorCode: "connection" }]);
    expect(reply).toEqual({
      outcome: "incomplete",
      incompleteReason: "toolError",
      mcpServerItemId: SERVER,
      connectorName: "GitHub",
    });
  });

  it("counts a generic operation that failed as a tool error, named by its tool", () => {
    expect(deriveReplyOutcome([failedOperation])).toEqual({
      outcome: "incomplete",
      incompleteReason: "toolError",
      connectorName: "item_patch",
    });
  });

  it("never reads the error code of a generic operation as an MCP failure kind", () => {
    for (const errorCode of ["timeout", "unavailable"]) {
      expect(deriveReplyOutcome([{ ...failedOperation, errorCode }])).toMatchObject({ incompleteReason: "toolError" });
    }
  });

  it("counts a step with the status error and no code (a result with details.error, an interrupted result, a call that never returned)", () => {
    const { errorCode: _code, ...withoutCode } = failedOperation;
    expect(deriveReplyOutcome([withoutCode])).toMatchObject({ outcome: "incomplete", incompleteReason: "toolError" });
  });

  it("counts a step that has an error code without the status error", () => {
    expect(deriveReplyOutcome([{ status: "ok", toolName: "legacy", errorCode: "unavailable" }])).toMatchObject({
      outcome: "incomplete",
      incompleteReason: "toolUnavailable",
    });
  });

  it("falls back to the operation when the step stored no tool name, and names nothing when it has neither", () => {
    expect(deriveReplyOutcome([{ status: "error", operation: "item.patch" }])).toMatchObject({
      connectorName: "item.patch",
    });
    const reply = deriveReplyOutcome([{ status: "error" }]);
    expect(reply).toEqual({ outcome: "incomplete", incompleteReason: "toolError" });
  });

  it("is complete when a failed call is followed by a successful call of the same operation", () => {
    expect(deriveReplyOutcome([failedOperation, { ...ok, operation: "item.patch", toolName: "item_patch" }])).toEqual({
      outcome: "complete",
    });
  });

  it("is complete when a failed MCP call is followed by a successful call of the same registration", () => {
    expect(deriveReplyOutcome([mcpTimeout, ok, mcpOk])).toEqual({ outcome: "complete" });
  });

  it("matches a step stored without identity on its tool name", () => {
    const failed: ReplyOutcomeStep = { status: "error", toolName: "legacy_tool" };
    expect(deriveReplyOutcome([failed, { status: "ok", toolName: "legacy_tool" }])).toEqual({ outcome: "complete" });
  });

  it("stays incomplete when the later success is of another operation", () => {
    expect(deriveReplyOutcome([failedOperation, ok])).toMatchObject({ outcome: "incomplete" });
  });

  it("stays incomplete when the later success is of another registration of the same server", () => {
    const otherTool: ReplyOutcomeStep = { ...mcpOk, mcpToolRegistrationId: OTHER_REGISTRATION, toolName: "mcp_read" };
    expect(deriveReplyOutcome([mcpTimeout, otherTool])).toMatchObject({ outcome: "incomplete" });
  });

  it("stays incomplete when the success came before the failure", () => {
    expect(deriveReplyOutcome([mcpOk, mcpTimeout])).toMatchObject({ outcome: "incomplete" });
  });

  it("is not cancelled by a retry that waits for approval or fails again", () => {
    const waiting: ReplyOutcomeStep = { status: "wait", operation: "item.patch", toolName: "item_patch" };
    expect(deriveReplyOutcome([failedOperation, waiting])).toMatchObject({ outcome: "incomplete" });
    expect(deriveReplyOutcome([mcpTimeout, { ...mcpTimeout, errorCode: "connection" }])).toMatchObject({
      incompleteReason: "toolError",
    });
  });

  it("takes the reason of the last failed step that was not cancelled", () => {
    const unavailable: ReplyOutcomeStep = {
      status: "error",
      toolName: "mcp_other_bbbbbbbb",
      errorCode: "unavailable",
      mcpToolRegistrationId: OTHER_REGISTRATION,
      mcpServerItemId: OTHER_SERVER,
      connectorName: "Calendar",
    };
    expect(deriveReplyOutcome([mcpTimeout, unavailable])).toMatchObject({
      incompleteReason: "toolUnavailable",
      mcpServerItemId: OTHER_SERVER,
    });
    // The later failure is cancelled, so the earlier one decides.
    const cancelled = [mcpTimeout, unavailable, { ...unavailable, status: "ok" as const, errorCode: undefined }];
    expect(deriveReplyOutcome(cancelled)).toMatchObject({ incompleteReason: "toolTimeout", mcpServerItemId: SERVER });
  });

  it("never cancels a failure of a step that names no tool, and is not cancelled by one", () => {
    const anonymous: ReplyOutcomeStep = { status: "error" };
    expect(deriveReplyOutcome([anonymous, { status: "ok" }])).toMatchObject({ outcome: "incomplete" });
  });

  it("is the same on every call for the same steps", () => {
    const steps = [mcpTimeout, ok];
    expect(deriveReplyOutcome(steps)).toEqual(deriveReplyOutcome(steps));
  });
});

/** A stored step as `projectSempReplySteps` writes it: the one reader of the column (issue #1887) needs it complete. */
function storedStep(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "tool",
    label: { key: "agentStep.title.namedTool", params: { toolName: "x" } },
    detail: { key: "agentStep.summary.failed", params: {} },
    status: "ok",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 5,
    ...extra,
  };
}

describe("replyOutcomeOfStoredSteps (issue #1890)", () => {
  it("reads a message without a stored summary as complete", () => {
    expect(replyOutcomeOfStoredSteps(null)).toEqual({ outcome: "complete" });
  });

  it("derives the outcome from the steps the one reader of the column returns", () => {
    const stored: unknown = [
      storedStep({
        toolName: "mcp_search_aaaaaaaa",
        status: "error",
        errorCode: "timeout",
        mcpToolRegistrationId: REGISTRATION,
        mcpServerItemId: SERVER,
        connectorName: "GitHub",
        timeoutMs: 60000,
      }),
      storedStep({ operation: "item.get" }),
    ];
    expect(replyOutcomeOfStoredSteps(stored)).toEqual({
      outcome: "incomplete",
      incompleteReason: "toolTimeout",
      mcpServerItemId: SERVER,
      connectorName: "GitHub",
      timeoutMs: 60000,
    });
  });

  it("cancels a stored failure by a later stored success of the same registration", () => {
    const stored: unknown = [
      storedStep({ status: "error", errorCode: "timeout", mcpToolRegistrationId: REGISTRATION }),
      storedStep({ mcpToolRegistrationId: REGISTRATION }),
    ];
    expect(replyOutcomeOfStoredSteps(stored)).toEqual({ outcome: "complete" });
  });

  it.each([
    ["a value that is no array", { status: "ok" }],
    ["a step that is no object", ["ok"]],
    ["a step with an unknown status", [storedStep({ status: "running" })]],
    ["a step that is not a complete stored step", [{ status: "ok", toolName: "x" }]],
  ])("refuses %s with the error of the column's reader", (_label, stored) => {
    expect(() => replyOutcomeOfStoredSteps(stored)).toThrow(
      /^Malformed semp_messages\.steps in database row$|^Unknown step/,
    );
  });
});
