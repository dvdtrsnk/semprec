import { describe, expect, it } from "vitest";
import { parseRestoreTestResultArgs } from "../observability/restoreTestResultArgs.js";

describe("parseRestoreTestResultArgs (issue #178)", () => {
  it("parses a passed run", () => {
    expect(parseRestoreTestResultArgs(["passed", "run-1"])).toEqual({ status: "passed", runId: "run-1" });
  });

  it("parses a failed run with its failed check", () => {
    expect(parseRestoreTestResultArgs(["failed", "run-1", "blobObjects"])).toEqual({
      status: "failed",
      runId: "run-1",
      failedCheck: "blobObjects",
    });
  });

  it("rejects an unknown failed check", () => {
    expect(() => parseRestoreTestResultArgs(["failed", "run-1", "somethingElse"])).toThrow(
      'unknown restore-test check "somethingElse"',
    );
  });

  it("rejects a missing or malformed run id", () => {
    expect(() => parseRestoreTestResultArgs(["passed"])).toThrow("expected a run id");
    expect(() => parseRestoreTestResultArgs(["passed", "run 1"])).toThrow("expected a run id");
    expect(() => parseRestoreTestResultArgs(["passed", "r".repeat(65)])).toThrow("expected a run id");
  });

  it("rejects an unknown status, a failure without a check, and extra arguments", () => {
    expect(() => parseRestoreTestResultArgs(["skipped", "run-1"])).toThrow("usage:");
    expect(() => parseRestoreTestResultArgs(["failed", "run-1"])).toThrow("usage:");
    expect(() => parseRestoreTestResultArgs(["passed", "run-1", "cleanup"])).toThrow("usage:");
    expect(() => parseRestoreTestResultArgs(["failed", "run-1", "cleanup", "extra"])).toThrow("usage:");
  });
});
