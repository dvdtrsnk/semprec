import { describe, expect, it } from "vitest";
import { restoreLedgerFailureMessage } from "../restoreLedgerFailure.js";
import { RestoreLedgerMismatchError } from "../validateRestoreLedger.js";

const PRIVILEGE = "Restore ledger validation failed: the restore role lacks a privilege";
const UNREACHABLE = "Restore ledger validation failed: the restore database is unreachable or refused the login";
const MISMATCH = "Restore ledger validation failed: the ledger does not cover the restored snapshot";
const GENERIC = "Restore ledger validation failed";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_TEXT = `SELECT * FROM public.tenant_deletions WHERE tenant_id = '${TENANT_ID}' password=hunter2`;

function withCode(code: string, message = SECRET_TEXT): Error {
  return Object.assign(new Error(message), { code });
}

describe("restoreLedgerFailureMessage", () => {
  it("maps an insufficient-privilege SQLSTATE to the privilege line", () => {
    expect(restoreLedgerFailureMessage(withCode("42501"))).toBe(PRIVILEGE);
  });

  it.each(["08000", "08001", "08006", "28000", "28P01"])(
    "maps SQLSTATE %s (connection exception or invalid authorization) to the unreachable line",
    (code) => {
      expect(restoreLedgerFailureMessage(withCode(code))).toBe(UNREACHABLE);
    },
  );

  it.each(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"])(
    "maps the Node connection error %s to the unreachable line",
    (code) => {
      expect(restoreLedgerFailureMessage(withCode(code))).toBe(UNREACHABLE);
    },
  );

  it.each(["timeout exceeded when trying to connect", "Connection terminated due to connection timeout"])(
    "maps the codeless pg connection timeout %j to the unreachable line",
    (message) => {
      expect(restoreLedgerFailureMessage(new Error(message))).toBe(UNREACHABLE);
    },
  );

  it("maps the validator's mismatch to the mismatch line", () => {
    expect(restoreLedgerFailureMessage(new RestoreLedgerMismatchError())).toBe(MISMATCH);
  });

  it("does not take a plain error with the mismatch message for the mismatch", () => {
    expect(restoreLedgerFailureMessage(new Error("Restore ledger validation failed"))).toBe(GENERIC);
  });

  it.each([
    ["an unrelated SQLSTATE", withCode("42P01")],
    ["a statement timeout", withCode("57014")],
    ["a SQLSTATE that only resembles class 08", withCode("X0800")],
    ["a class prefix without its subclass", withCode("08")],
    ["a file error", withCode("ENOENT")],
    ["an invalid ledger file", new Error("Invalid restore ledger")],
    ["a plain error", new Error(SECRET_TEXT)],
    ["a timeout message that only contains the pg text", new Error("a timeout exceeded when trying to connect twice")],
  ])("maps %s to the generic line", (_name, error) => {
    expect(restoreLedgerFailureMessage(error)).toBe(GENERIC);
  });

  it.each([
    ["a string", SECRET_TEXT],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42501],
    ["an object with the privilege code as a number", { code: 42501 }],
  ])("maps %s that is not an error to the generic line", (_name, value) => {
    expect(restoreLedgerFailureMessage(value)).toBe(GENERIC);
  });

  it("finds a failure inside an AggregateError", () => {
    const aggregate = new AggregateError([new Error("first"), withCode("42501")], "Restore ledger pool cleanup failed");
    expect(restoreLedgerFailureMessage(aggregate)).toBe(PRIVILEGE);
  });

  it("finds a failure inside a nested AggregateError", () => {
    const inner = new AggregateError([withCode("ECONNREFUSED")], "inner");
    expect(restoreLedgerFailureMessage(new AggregateError([new Error("first"), inner], "outer"))).toBe(UNREACHABLE);
  });

  it("finds a failure along a cause chain", () => {
    const root = withCode("28P01");
    const wrapped = new Error("wrapper", { cause: new Error("middle", { cause: root }) });
    expect(restoreLedgerFailureMessage(wrapped)).toBe(UNREACHABLE);
  });

  it("finds a failure in the cause of an error inside an AggregateError", () => {
    const aggregate = new AggregateError([new Error("outer", { cause: new RestoreLedgerMismatchError() })], "all");
    expect(restoreLedgerFailureMessage(aggregate)).toBe(MISMATCH);
  });

  it("lets the validator's mismatch win over a connection failure beside it, in either order", () => {
    const mismatch = new RestoreLedgerMismatchError();
    const connection = withCode("ECONNREFUSED");
    expect(restoreLedgerFailureMessage(new AggregateError([mismatch, connection], "cleanup"))).toBe(MISMATCH);
    expect(restoreLedgerFailureMessage(new AggregateError([connection, mismatch], "cleanup"))).toBe(MISMATCH);
  });

  it("lets a missing privilege win over a connection failure beside it, in either order", () => {
    const privilege = withCode("42501");
    const connection = withCode("08006");
    expect(restoreLedgerFailureMessage(new AggregateError([privilege, connection], "cleanup"))).toBe(PRIVILEGE);
    expect(restoreLedgerFailureMessage(new AggregateError([connection, privilege], "cleanup"))).toBe(PRIVILEGE);
  });

  it("terminates on a cause cycle and still classifies a failure inside it", () => {
    const first = new Error("first");
    const second = withCode("42501");
    Object.assign(first, { cause: second });
    Object.assign(second, { cause: first });
    expect(restoreLedgerFailureMessage(first)).toBe(PRIVILEGE);
    const lone = new Error("lone");
    Object.assign(lone, { cause: lone });
    expect(restoreLedgerFailureMessage(lone)).toBe(GENERIC);
  });

  it("visits an error that appears twice in an aggregate once", () => {
    const shared = withCode("ETIMEDOUT");
    expect(restoreLedgerFailureMessage(new AggregateError([shared, shared], "twice"))).toBe(UNREACHABLE);
  });

  it("inspects a cause chain of ten errors", () => {
    let error: Error = withCode("42501");
    for (let depth = 0; depth < 10; depth += 1) error = new Error(`level ${depth}`, { cause: error });
    expect(restoreLedgerFailureMessage(error)).toBe(PRIVILEGE);
  });

  it("stops walking a cause chain longer than its bound", () => {
    let error: Error = withCode("42501");
    for (let depth = 0; depth < 100; depth += 1) error = new Error(`level ${depth}`, { cause: error });
    expect(restoreLedgerFailureMessage(error)).toBe(GENERIC);
  });

  it("never prints an id, SQL text or error message", () => {
    const inputs: unknown[] = [
      withCode("42501"),
      withCode("08006"),
      withCode("ECONNREFUSED"),
      new Error(SECRET_TEXT),
      new AggregateError([withCode("42501"), new Error(SECRET_TEXT)], SECRET_TEXT, { cause: new Error(SECRET_TEXT) }),
      new RestoreLedgerMismatchError(),
      SECRET_TEXT,
    ];
    for (const input of inputs) {
      const line = restoreLedgerFailureMessage(input);
      expect([PRIVILEGE, UNREACHABLE, MISMATCH, GENERIC]).toContain(line);
      expect(line).not.toContain(TENANT_ID);
      expect(line).not.toContain("SELECT");
      expect(line).not.toContain("hunter2");
    }
  });
});
