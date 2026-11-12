import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_RUN_ERROR_CODES, type AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import { agentRunErrorFields, agentRunErrorSummary } from "../agentRuns/agentRunErrorSummary.js";

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
