import { describe, expect, it } from "vitest";
import { MAX_RESTORE_LEDGER_BYTES, parseRestoreReplayLedger } from "../tenancy/restoreReplayLedger.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const parse = (text: string): string[] => parseRestoreReplayLedger(Buffer.from(text));

describe("restore replay ledger artifact", () => {
  it("accepts an empty file and exact ordered ids with or without a final newline", () => {
    expect(parse("")).toEqual([]);
    expect(parse(`${A}\n${B}\n`)).toEqual([A, B]);
    expect(parse(A)).toEqual([A]);
  });
  it("rejects duplicates, blank lines, malformed and noncanonical ids", () => {
    for (const value of [`${A}\n${A}\n`, `${A}\n\n${B}`, "\n", "secret", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]) {
      expect(() => parse(value)).toThrow();
    }
  });
  it("rejects invalid UTF-8 and oversized data", () => {
    expect(() => parseRestoreReplayLedger(Buffer.from([0xff]))).toThrow();
    expect(() => parseRestoreReplayLedger(Buffer.alloc(MAX_RESTORE_LEDGER_BYTES + 1))).toThrow();
  });
});
