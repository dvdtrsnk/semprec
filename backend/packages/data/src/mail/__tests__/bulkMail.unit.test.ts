import { describe, expect, it } from "vitest";
import { detectBulkMail } from "../bulkMail.js";

describe("detectBulkMail", () => {
  it("flags a message carrying List-Unsubscribe", () => {
    expect(detectBulkMail({ listUnsubscribe: "<mailto:u@example.com>", senderAddress: "anna@example.com" })).toBe(true);
  });

  it("flags a message carrying List-Id", () => {
    expect(detectBulkMail({ listId: "<list.example.com>", senderAddress: "anna@example.com" })).toBe(true);
  });

  it.each(["bulk", "list", "junk", " Bulk ", "JUNK"])("flags Precedence %j", (precedence) => {
    expect(detectBulkMail({ precedence, senderAddress: "anna@example.com" })).toBe(true);
  });

  it("flags present empty or whitespace list and automatic headers", () => {
    expect(detectBulkMail({ listUnsubscribe: "" })).toBe(true);
    expect(detectBulkMail({ listId: "  " })).toBe(true);
    expect(detectBulkMail({ autoSubmitted: "" })).toBe(true);
  });

  it("does not flag an unrelated Precedence value", () => {
    expect(detectBulkMail({ precedence: "first-class", senderAddress: "anna@example.com" })).toBe(false);
  });

  it("flags Auto-Submitted other than no", () => {
    expect(detectBulkMail({ autoSubmitted: "auto-generated", senderAddress: "anna@example.com" })).toBe(true);
  });

  it.each(["no", " No ", "NO"])("does not flag Auto-Submitted %j from a person", (autoSubmitted) => {
    expect(detectBulkMail({ autoSubmitted, senderAddress: "anna@example.com" })).toBe(false);
  });

  it.each([
    "No-Reply@example.com",
    "noreply@example.com",
    "do-not-reply@example.com",
    "donotreply@example.com",
    "MAILER-DAEMON@example.com",
    "notification@example.com",
    "Notifications@example.com",
  ])("flags the automatic sender %s", (senderAddress) => {
    expect(detectBulkMail({ senderAddress })).toBe(true);
  });

  it("does not flag a sender that merely contains an automatic word", () => {
    expect(detectBulkMail({ senderAddress: "noreply.team@example.com" })).toBe(false);
    expect(detectBulkMail({ senderAddress: "anna@noreply.example.com" })).toBe(false);
  });

  it("does not flag an ordinary message and tolerates absent or malformed values", () => {
    expect(detectBulkMail({})).toBe(false);
    expect(detectBulkMail({ listUnsubscribe: null, listId: null, precedence: null, senderAddress: null })).toBe(false);
    expect(
      detectBulkMail({
        listUnsubscribe: 5 as unknown as string,
        precedence: {} as unknown as string,
        autoSubmitted: ["x"] as unknown as string,
        senderAddress: 7 as unknown as string,
      }),
    ).toBe(false);
  });
});
