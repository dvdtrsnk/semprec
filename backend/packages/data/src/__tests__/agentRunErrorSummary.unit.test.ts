import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_RUN_ERROR_CODES, type AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import {
  agentRunErrorFields,
  agentRunErrorSummary,
  agentRunIncompleteSummary,
} from "../agentRuns/agentRunErrorSummary.js";
import { REPLY_INCOMPLETE_REASONS, type IncompleteReplyOutcome } from "../agentRuns/replyOutcome.js";

const CZECH: Record<AgentRunErrorCode, string> = {
  budgetExceeded: "Rozpočet na AI vyčerpán",
  modelError: "Chyba AI modelu",
  cancelled: "Zrušeno",
  interrupted: "Přerušeno restartem",
  internal: "Interní chyba",
};

const ENGLISH: Record<AgentRunErrorCode, string> = {
  budgetExceeded: "AI budget used up",
  modelError: "AI model error",
  cancelled: "Cancelled",
  interrupted: "Interrupted by a restart",
  internal: "Internal error",
};

describe("agentRunErrorSummary (issue #1824)", () => {
  it.each(AGENT_RUN_ERROR_CODES)("returns the Czech phrase for %s", async (code) => {
    expect(await agentRunErrorSummary(code, "cs")).toBe(CZECH[code]);
  });

  it.each(AGENT_RUN_ERROR_CODES)("returns the English phrase for %s", async (code) => {
    expect(await agentRunErrorSummary(code, "en")).toBe(ENGLISH[code]);
  });

  it("falls back to the English phrase for a locale other than cs", async () => {
    expect(await agentRunErrorSummary("modelError", "de")).toBe(ENGLISH.modelError);
  });

  it("returns a bare phrase without a trailing period for every code in both locales", async () => {
    for (const locale of ["cs", "en"]) {
      for (const code of AGENT_RUN_ERROR_CODES) {
        const summary = await agentRunErrorSummary(code, locale);
        expect(summary).not.toBe("");
        expect(summary).not.toMatch(/[.!?]$/);
        expect(summary).not.toContain(`agentRun.error.${code}.summary`);
      }
    }
  });
});

describe("agentRunErrorFields (issue #1824)", () => {
  it("returns the stored code and its phrase in the locale for a failed run", async () => {
    expect(await agentRunErrorFields({ status: "error", errorCode: "budgetExceeded" }, "cs")).toEqual({
      errorCode: "budgetExceeded",
      errorSummary: CZECH.budgetExceeded,
    });
    expect(await agentRunErrorFields({ status: "error", errorCode: "budgetExceeded" }, "en")).toEqual({
      errorCode: "budgetExceeded",
      errorSummary: ENGLISH.budgetExceeded,
    });
  });

  it("reads a failed run with a null code as internal", async () => {
    expect(await agentRunErrorFields({ status: "error", errorCode: null }, "en")).toEqual({
      errorCode: "internal",
      errorSummary: ENGLISH.internal,
    });
  });

  it.each(["done", "running"] as const)("returns null for both fields for a %s run", async (status) => {
    expect(await agentRunErrorFields({ status, errorCode: null }, "cs")).toEqual({
      errorCode: null,
      errorSummary: null,
    });
  });
});

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timedOut: IncompleteReplyOutcome = {
  outcome: "incomplete",
  incompleteReason: "toolTimeout",
  mcpServerItemId: SERVER,
  connectorName: "GitHub",
  timeoutMs: 60000,
};
const unavailable: IncompleteReplyOutcome = {
  outcome: "incomplete",
  incompleteReason: "toolUnavailable",
  connectorName: "GitHub",
};
const failed: IncompleteReplyOutcome = {
  outcome: "incomplete",
  incompleteReason: "toolError",
  mcpServerItemId: SERVER,
  connectorName: "GitHub",
};

describe("agentRunIncompleteSummary (issue #1890)", () => {
  it("names the server in the nominative for an unavailable one, in both locales", async () => {
    expect(await agentRunIncompleteSummary(unavailable, "en")).toBe("GitHub unavailable");
    expect(await agentRunIncompleteSummary(unavailable, "cs")).toBe("GitHub není dostupný");
  });

  it("names the seconds of the stored timeout and not a constant", async () => {
    expect(await agentRunIncompleteSummary(timedOut, "en")).toBe("connection timed out (60 s)");
    expect(await agentRunIncompleteSummary(timedOut, "cs")).toBe("spojení vypršelo (60 s)");
    expect(await agentRunIncompleteSummary({ ...timedOut, timeoutMs: 15000 }, "en")).toBe(
      "connection timed out (15 s)",
    );
    expect(await agentRunIncompleteSummary({ ...timedOut, timeoutMs: 1500 }, "en")).toBe(
      "connection timed out (1.5 s)",
    );
  });

  it("names the tool for a tool error, in both locales", async () => {
    expect(await agentRunIncompleteSummary(failed, "en")).toBe("tool GitHub returned an error");
    expect(await agentRunIncompleteSummary(failed, "cs")).toBe("nástroj GitHub vrátil chybu");
  });

  it("reads a locale other than cs in English", async () => {
    expect(await agentRunIncompleteSummary(unavailable, "de")).toBe("GitHub unavailable");
  });

  it("reads a timeout that stored no timeout as a tool error", async () => {
    const { timeoutMs: _timeout, ...withoutTimeout } = timedOut;
    expect(await agentRunIncompleteSummary(withoutTimeout, "en")).toBe("tool GitHub returned an error");
  });

  it("reads the unnamed entry of the reason, in both locales, when the reply recorded no name", async () => {
    const { connectorName: _failedName, ...failedUnnamed } = failed;
    const { connectorName: _unavailableName, ...unavailableUnnamed } = unavailable;
    expect(await agentRunIncompleteSummary(failedUnnamed, "en")).toBe("a tool returned an error");
    expect(await agentRunIncompleteSummary(failedUnnamed, "cs")).toBe("nástroj vrátil chybu");
    expect(await agentRunIncompleteSummary(unavailableUnnamed, "en")).toBe("tool unavailable");
    expect(await agentRunIncompleteSummary(unavailableUnnamed, "cs")).toBe("nástroj není dostupný");
    const { timeoutMs: _timeout, ...timedOutNoSeconds } = timedOut;
    const { connectorName: _timedOutName, ...timedOutUnnamed } = timedOutNoSeconds;
    expect(await agentRunIncompleteSummary(timedOutUnnamed, "en")).toBe("a tool returned an error");
  });

  it("does not expand a placeholder inside the server's name", async () => {
    expect(await agentRunIncompleteSummary({ ...unavailable, connectorName: "{seconds}" }, "en")).toBe(
      "{seconds} unavailable",
    );
  });

  it("has an entry in both catalogs for every reason, without a trailing period", async () => {
    for (const locale of ["cs", "en"]) {
      for (const incompleteReason of REPLY_INCOMPLETE_REASONS) {
        const text = await agentRunIncompleteSummary(
          { outcome: "incomplete", incompleteReason, connectorName: "X", timeoutMs: 2000 },
          locale,
        );
        expect(text).not.toContain("agentRun.incomplete");
        expect(text).not.toMatch(/[.!?]$/);
        expect(text).not.toMatch(/\{\w+\}/);
        const unnamed = await agentRunIncompleteSummary({ outcome: "incomplete", incompleteReason }, locale);
        expect(unnamed).not.toContain("agentRun.incomplete");
        expect(unnamed).not.toMatch(/[.!?]$/);
        expect(unnamed).not.toMatch(/\{\w+\}/);
        expect(unnamed).not.toContain("?");
      }
    }
  });
});

describe("agentRunErrorFields for an incomplete reply (issue #1890)", () => {
  it("returns no code and the summary of the reply for a done run", async () => {
    expect(await agentRunErrorFields({ status: "done", errorCode: null }, "en", unavailable)).toEqual({
      errorCode: null,
      errorSummary: "GitHub unavailable",
    });
  });

  it("keeps the summary of its error code for a run closed with one, even when the reply is incomplete", async () => {
    expect(await agentRunErrorFields({ status: "error", errorCode: "modelError" }, "en", unavailable)).toEqual({
      errorCode: "modelError",
      errorSummary: ENGLISH.modelError,
    });
  });

  it("returns nothing for a running run, whatever reply is passed, and for a done run without one", async () => {
    expect(await agentRunErrorFields({ status: "running", errorCode: null }, "en", unavailable)).toEqual({
      errorCode: null,
      errorSummary: null,
    });
    expect(await agentRunErrorFields({ status: "done", errorCode: null }, "en", null)).toEqual({
      errorCode: null,
      errorSummary: null,
    });
  });
});

describe("the data package build (issue #1824)", () => {
  it("copies agentRuns/i18n into dist", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const build =
      typeof manifest === "object" && manifest !== null && "scripts" in manifest ? manifest.scripts : undefined;
    const script = typeof build === "object" && build !== null && "build" in build ? build.build : undefined;
    expect(script).toEqual(
      expect.stringContaining("mkdir -p dist/agentRuns/i18n && cp src/agentRuns/i18n/*.json dist/agentRuns/i18n/"),
    );
  });
});
