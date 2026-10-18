import { describe, expect, it } from "vitest";
import { parseTenantDeletionLedger } from "../tenancy/tenantDeletionLedger.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseTenantDeletionLedger", () => {
  it("returns the de-duplicated uuids and ignores blank lines", () => {
    expect(parseTenantDeletionLedger(`${A}\n\n${B}\n${A}\n`)).toEqual([A, B]);
  });

  it("returns an empty list for an empty file", () => {
    expect(parseTenantDeletionLedger("")).toEqual([]);
  });

  it("accepts CRLF line endings", () => {
    expect(parseTenantDeletionLedger(`${A}\r\n${B}\r\n`)).toEqual([A, B]);
  });

  it("throws naming the 1-based line number of a line that is not a uuid", () => {
    expect(() => parseTenantDeletionLedger(`${A}\n\nnot-a-uuid\n${B}`)).toThrow("line 3");
  });

  it("does not echo the offending line", () => {
    expect(() => parseTenantDeletionLedger("secret-content")).toThrow(/^(?!.*secret-content)/);
  });

  it("rejects an uppercase uuid", () => {
    expect(() => parseTenantDeletionLedger("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase())).toThrow("line 1");
  });
});
