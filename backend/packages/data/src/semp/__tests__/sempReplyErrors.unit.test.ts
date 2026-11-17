import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRunError, AiBudgetExceededError, AGENT_RUN_ERROR_CODES } from "../../agentRuns/agentRunErrorCodes.js";
import { REPLY_INCOMPLETE_REASONS } from "../../agentRuns/replyOutcome.js";
import {
  classifySempTurnFailure,
  parseSempReplyErrorCode,
  parseSempReplyErrorParams,
  renderSempReplyFailure,
  type SempReplyFailureCode,
} from "../sempReplyErrors.js";
import type { SempReplyStep } from "../sempReplySteps.js";

const RUNNING = { aborted: false, reason: undefined };

function step(over: Partial<SempReplyStep>): SempReplyStep {
  return {
    kind: "tool",
    label: { key: "agentStep.title.namedTool", params: { toolName: "search" } },
    detail: { key: "agentStep.summary.done", params: {} },
    status: "ok",
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 1,
    ...over,
  };
}

describe("classifySempTurnFailure", () => {
  it("classifies the typed budget refusal as budgetExceeded, whatever its message says", () => {
    const error = new AiBudgetExceededError();
    error.message = "something that is not about a budget";
    expect(classifySempTurnFailure({ error, signal: RUNNING, steps: [] }).errorCode).toBe("budgetExceeded");
  });

  it("does not take a budget code from the text of an ordinary error", () => {
    const error = new Error("AI budget exceeded");
    expect(classifySempTurnFailure({ error, signal: RUNNING, steps: [] }).errorCode).toBe("internal");
  });

  it("keeps the code a typed error carries (a model failure is modelError)", () => {
    const error = new AgentRunError("modelError", "the model failed");
    expect(classifySempTurnFailure({ error, signal: RUNNING, steps: [] }).errorCode).toBe("modelError");
  });

  it("keeps the cancelled code of a cancelled turn", () => {
    const error = new AgentRunError("cancelled", "account deactivated");
    expect(classifySempTurnFailure({ error, signal: RUNNING, steps: [] }).errorCode).toBe("cancelled");
  });

  it.each([new Error("boom"), "a thrown string", null, undefined])("classifies %j as internal", (error) => {
    expect(classifySempTurnFailure({ error, signal: RUNNING, steps: [] }).errorCode).toBe("internal");
  });

  it("classifies an aborted turn as cancelled even when the error that surfaced is an ordinary one", () => {
    const signal = { aborted: true, reason: undefined };
    expect(classifySempTurnFailure({ error: new Error("provider aborted"), signal, steps: [] }).errorCode).toBe(
      "cancelled",
    );
  });

  it("classifies an abort of the shutdown as interrupted, not cancelled", () => {
    const signal = { aborted: true, reason: "shutdown" };
    expect(classifySempTurnFailure({ error: new AgentRunError("cancelled", "x"), signal, steps: [] }).errorCode).toBe(
      "interrupted",
    );
  });

  it("classifies an AggregateError by the turn error it keeps as its cause", () => {
    const cause = new AiBudgetExceededError();
    const aggregate = new AggregateError([cause, new Error("cleanup")], "cleanup failed", { cause });
    expect(classifySempTurnFailure({ error: aggregate, signal: RUNNING, steps: [] }).errorCode).toBe("budgetExceeded");
    const withoutCause = new AggregateError([new Error("a")], "no cause");
    expect(classifySempTurnFailure({ error: withoutCause, signal: RUNNING, steps: [] }).errorCode).toBe("internal");
  });

  it("stores no params for a turn with no failed step", () => {
    const steps = [step({ status: "ok" }), step({ status: "wait" })];
    expect(classifySempTurnFailure({ error: new Error("x"), signal: RUNNING, steps }).errorParams).toEqual({});
    expect(classifySempTurnFailure({ error: new Error("x"), signal: RUNNING, steps: [] }).errorParams).toEqual({});
  });

  it("names the last failed step and the connector and timeout of an MCP step, never the error", () => {
    const steps = [
      step({ status: "error", label: { key: "agentStep.title.operation.item.get", params: {} } }),
      step({
        status: "error",
        errorCode: "timeout",
        connectorName: "Calendar",
        timeoutMs: 60000,
        label: { key: "agentStep.title.namedTool", params: { toolName: "events", count: 2 } },
      }),
      step({ status: "ok" }),
    ];
    const error = new Error("secret meeting title: Salary review");
    const { errorParams } = classifySempTurnFailure({ error, signal: RUNNING, steps });
    expect(errorParams).toEqual({
      failedStep: { key: "agentStep.title.namedTool", params: { toolName: "events", count: 2 } },
      connectorName: "Calendar",
      timeoutMs: 60000,
    });
    expect(JSON.stringify(errorParams)).not.toContain("Salary");
  });

  it("omits the connector and timeout of a failed step that is no MCP call, and drops non-scalar label params", () => {
    const steps = [
      step({
        status: "error",
        errorCode: "not_found",
        label: {
          key: "agentStep.title.operation.item.patch",
          params: { targetModuleId: "tasks", changedKeys: ["a"] },
        },
      }),
    ];
    const { errorParams } = classifySempTurnFailure({ error: new Error("x"), signal: RUNNING, steps });
    expect(errorParams).toEqual({
      failedStep: { key: "agentStep.title.operation.item.patch", params: { targetModuleId: "tasks" } },
    });
  });
});

describe("the readers of the stored columns", () => {
  it("reads a NULL code as internal, every known code as itself and refuses an unknown one", () => {
    expect(parseSempReplyErrorCode(null)).toBe("internal");
    for (const code of AGENT_RUN_ERROR_CODES) expect(parseSempReplyErrorCode(code)).toBe(code);
    expect(() => parseSempReplyErrorCode("nope")).toThrow("Malformed semp_messages.error_code");
  });

  it("reads a NULL column as no params, a valid object as itself and refuses anything else", () => {
    expect(parseSempReplyErrorParams(null)).toEqual({});
    const params = { connectorName: "Calendar", timeoutMs: 15000, failedStep: { key: "k", params: { a: "b", n: 1 } } };
    expect(parseSempReplyErrorParams(params)).toEqual(params);
    for (const bad of [{ message: "raw text" }, { timeoutMs: -1 }, { failedStep: { key: "k" } }, [], "x"]) {
      expect(() => parseSempReplyErrorParams(bad)).toThrow("Malformed semp_messages.error_params");
    }
  });
});

describe("renderSempReplyFailure", () => {
  const codes: SempReplyFailureCode[] = [...AGENT_RUN_ERROR_CODES, ...REPLY_INCOMPLETE_REASONS];

  it("has a different non-empty text for every code in Czech and in English, and none is a bare key", async () => {
    const params = { connectorName: "Calendar", timeoutMs: 15000 };
    const english = await Promise.all(codes.map((code) => renderSempReplyFailure(code, params, "en")));
    const czech = await Promise.all(codes.map((code) => renderSempReplyFailure(code, params, "cs")));
    expect(new Set(english).size).toBe(codes.length);
    expect(new Set(czech).size).toBe(codes.length);
    for (const text of [...english, ...czech]) {
      expect(text).not.toBe("");
      expect(text).not.toContain("reply.failure");
      expect(text).not.toMatch(/\{\w+\}/);
    }
    expect(english.every((text, index) => text !== czech[index])).toBe(true);
  });

  it("renders the budget text in the language of the locale and reads English for any locale but cs", async () => {
    expect(await renderSempReplyFailure("budgetExceeded", {}, "en")).toBe(
      "I could not answer because the AI spending limit is used up.",
    );
    expect(await renderSempReplyFailure("budgetExceeded", {}, "cs")).toBe(
      "Odpověď se nepodařila, protože je vyčerpaný limit výdajů na AI.",
    );
    expect(await renderSempReplyFailure("budgetExceeded", {}, "de")).toBe(
      await renderSempReplyFailure("budgetExceeded", {}, "en"),
    );
  });

  it("renders a run error code the same whatever the params hold", async () => {
    const plain = await renderSempReplyFailure("modelError", {}, "en");
    const withParams = await renderSempReplyFailure(
      "modelError",
      { connectorName: "Calendar", timeoutMs: 1000, failedStep: { key: "k", params: {} } },
      "en",
    );
    expect(withParams).toBe(plain);
    expect(plain).not.toContain("Calendar");
  });

  it("names the connector and the seconds of a timeout, to a tenth of a second", async () => {
    expect(await renderSempReplyFailure("toolTimeout", { connectorName: "Calendar", timeoutMs: 60000 }, "en")).toBe(
      "The connection to Calendar timed out after 60 s, so the reply is incomplete.",
    );
    expect(await renderSempReplyFailure("toolTimeout", { connectorName: "Calendar", timeoutMs: 1250 }, "cs")).toBe(
      "Spojení s nástrojem Calendar vypršelo po 1.3 s, proto je odpověď neúplná.",
    );
  });

  it("reads a timeout that stored no timeoutMs as a tool error", async () => {
    expect(await renderSempReplyFailure("toolTimeout", { connectorName: "Calendar" }, "en")).toBe(
      await renderSempReplyFailure("toolError", { connectorName: "Calendar" }, "en"),
    );
  });

  it("uses the catalog's generic word for an unavailable or failed tool that has no name", async () => {
    expect(await renderSempReplyFailure("toolUnavailable", {}, "en")).toBe(
      "(unnamed) is not available, so the reply is incomplete.",
    );
    expect(await renderSempReplyFailure("toolError", { connectorName: "Mail" }, "cs")).toBe(
      "Nástroj Mail vrátil chybu, proto je odpověď neúplná.",
    );
  });

  it("does not expand a placeholder that a connector name itself contains", async () => {
    const text = await renderSempReplyFailure("toolError", { connectorName: "{seconds}" }, "en");
    expect(text).toBe("{seconds} returned an error, so the reply is incomplete.");
  });
});

describe("the Semp catalogs", () => {
  it("hold the same reply.failure keys in Czech and English, one for every code", async () => {
    const dir = join(fileURLToPath(new URL("../i18n", import.meta.url)));
    const load = async (name: string): Promise<Record<string, string>> => {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("Catalog is not an object");
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    };
    const keys = async (name: string) =>
      Object.keys(await load(name))
        .filter((key) => key.startsWith("reply.failure."))
        .sort();
    const expected = [
      ...[...AGENT_RUN_ERROR_CODES, ...REPLY_INCOMPLETE_REASONS].map((code) => `reply.failure.${code}`),
      "reply.failure.unnamedConnector",
    ].sort();
    expect(await keys("en.json")).toEqual(expected);
    expect(await keys("cs.json")).toEqual(expected);
  });
});
