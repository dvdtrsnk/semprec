import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SempReplyStep } from "../sempReplySteps.js";
import { parseStoredSempReplySteps } from "../sempStoredSteps.js";

/** A stored tool step with every optional field, as `projectSempReplySteps` writes it. */
function fullToolStep(): SempReplyStep {
  return {
    kind: "tool",
    toolCallId: "call-1",
    toolName: "item_patch",
    operation: "item.patch",
    label: { key: "agentStep.title.operation.item.patch", params: { targetModuleId: "tasks" } },
    detail: {
      key: "agentStep.summary.changedProperties",
      params: {
        itemName: "Buy milk",
        count: 1,
        changedKeys: ["status"],
        changes: [{ key: "status", before: "todo", after: "done" }],
      },
    },
    status: "wait",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 40,
    approvalRequestId: randomUUID(),
    errorCode: "version_conflict",
    mcpToolRegistrationId: randomUUID(),
    mcpServerItemId: randomUUID(),
    connectorName: "GitHub",
    timeoutMs: 60000,
    tokens: { input: 3, output: 4 },
  };
}

function modelStep(): SempReplyStep {
  return {
    kind: "model",
    label: { key: "agentStep.title.plan", params: {} },
    detail: { key: "agentStep.summary.done", params: {} },
    status: "ok",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 5,
  };
}

/** `step` with `field` replaced by `value`, typed as the loose JSON the column holds. */
function withField(step: SempReplyStep, field: string, value: unknown): unknown {
  return { ...step, [field]: value };
}

describe("parseStoredSempReplySteps (issue #1887)", () => {
  it("is undefined for a null column: a reply with no stored summary", () => {
    expect(parseStoredSempReplySteps(null)).toBeUndefined();
  });

  it("returns an empty list for a stored empty summary", () => {
    expect(parseStoredSempReplySteps([])).toEqual([]);
  });

  it("returns the steps the projector writes, optional fields included, unchanged", () => {
    const steps = [fullToolStep(), modelStep()];

    expect(parseStoredSempReplySteps(JSON.parse(JSON.stringify(steps)))).toEqual(steps);
  });

  it("does not add a key a stored step does not have", () => {
    const [step] = parseStoredSempReplySteps([modelStep()]) ?? [];

    expect(Object.keys(step ?? {}).sort()).toEqual(["detail", "durationMs", "kind", "label", "startedAt", "status"]);
  });

  it.each([
    ["a value that is no array", { steps: [] }],
    ["an element that is no object", [null]],
    ["an element that is an array", [[]]],
    ["an unknown kind", [withField(modelStep(), "kind", "other")]],
    ["a missing kind", [withField(modelStep(), "kind", undefined)]],
    ["an unknown status", [withField(modelStep(), "status", "running")]],
    ["a start that is no string", [withField(modelStep(), "startedAt", 5)]],
    ["a duration that is no number", [withField(modelStep(), "durationMs", "5")]],
    ["a duration that is not finite", [withField(modelStep(), "durationMs", null)]],
    ["a tool call id that is no string", [withField(fullToolStep(), "toolCallId", 1)]],
    ["an operation that is no generic operation", [withField(fullToolStep(), "operation", "item.explode")]],
    ["an approval request id that is no uuid", [withField(fullToolStep(), "approvalRequestId", "not-a-uuid")]],
    ["an approval request id that is no string", [withField(fullToolStep(), "approvalRequestId", 7)]],
    ["an error code that is no string", [withField(fullToolStep(), "errorCode", 7)]],
    ["an MCP tool registration that is no string", [withField(fullToolStep(), "mcpToolRegistrationId", 7)]],
    ["an MCP server id that is no string", [withField(fullToolStep(), "mcpServerItemId", 7)]],
    ["a connector name that is no string", [withField(fullToolStep(), "connectorName", 7)]],
    ["a timeout that is no number", [withField(fullToolStep(), "timeoutMs", "60000")]],
    ["a timeout that is not finite", [withField(fullToolStep(), "timeoutMs", null)]],
    ["tokens that are no object", [withField(fullToolStep(), "tokens", 7)]],
    ["tokens that are no integers", [withField(fullToolStep(), "tokens", { input: 1.5, output: 2 })]],
    ["tokens with a missing count", [withField(fullToolStep(), "tokens", { input: 1 })]],
    ["a label that is no object", [withField(modelStep(), "label", "x")]],
    ["a label without a key", [withField(modelStep(), "label", { params: {} })]],
    ["a label without params", [withField(modelStep(), "label", { key: "agentStep.title.plan" })]],
    ["a detail whose params hold a boolean", [withField(modelStep(), "detail", { key: "k", params: { done: true } })]],
    [
      "a detail whose params hold a list of numbers",
      [withField(modelStep(), "detail", { key: "k", params: { n: [1] } })],
    ],
  ])("refuses %s", (_label, stored) => {
    expect(() => parseStoredSempReplySteps(stored)).toThrow(
      /^Malformed semp_messages\.steps in database row$|^Unknown step/,
    );
  });
});
