import { describe, expect, it } from "vitest";
import { invalidReasonSchema, isFinalInvalid, type InvalidReason } from "../inboxTickAction.js";
import { renderInvalidReason } from "../invalidReason.js";

const SOURCE_REASON: InvalidReason = { code: "sourceDeleted", field: "", itemId: "item-1", label: "Buy milk" };
const ARCHIVED_REASON: InvalidReason = {
  code: "targetArchived",
  field: "project",
  itemId: "item-2",
  label: "Website redesign",
};

describe("invalidReason schema (issue #1482)", () => {
  it("accepts each of the three codes", () => {
    for (const code of ["sourceDeleted", "targetArchived", "targetDeleted"] as const) {
      expect(invalidReasonSchema.safeParse({ code, field: "", itemId: "item-1", label: "x" }).success).toBe(true);
    }
  });

  it("rejects a code outside the three", () => {
    expect(invalidReasonSchema.safeParse({ ...SOURCE_REASON, code: "unknown" }).success).toBe(false);
  });

  it("rejects a reason without its label", () => {
    const { label: _label, ...withoutLabel } = SOURCE_REASON;
    expect(invalidReasonSchema.safeParse(withoutLabel).success).toBe(false);
  });
});

describe("isFinalInvalid (issue #1482)", () => {
  it("is true for an invalid card whose reason is sourceDeleted", () => {
    expect(isFinalInvalid({ status: "invalid", invalidReason: SOURCE_REASON })).toBe(true);
  });

  it("is false for an invalid card whose reason is fixable", () => {
    expect(isFinalInvalid({ status: "invalid", invalidReason: ARCHIVED_REASON })).toBe(false);
  });

  it("is false for a legacy invalid card with no invalidReason, which is fixable", () => {
    expect(isFinalInvalid({ status: "invalid" })).toBe(false);
    expect(isFinalInvalid({ status: "invalid", invalidReason: null })).toBe(false);
  });

  it("is false for an invalid card whose stored reason does not parse", () => {
    expect(isFinalInvalid({ status: "invalid", invalidReason: { code: "sourceDeleted" } })).toBe(false);
  });

  it("is false for a card that is not invalid, even with a sourceDeleted reason", () => {
    expect(isFinalInvalid({ status: "proposed", invalidReason: SOURCE_REASON })).toBe(false);
  });
});

describe("renderInvalidReason (issue #1482)", () => {
  it("renders the Czech sentence with the label for locale cs", async () => {
    expect(await renderInvalidReason(SOURCE_REASON, "cs")).toBe(
      "Zdrojová položka Inboxu „Buy milk“ byla smazána, takže tento návrh už nelze dokončit.",
    );
  });

  it("renders the English sentence with the label for locale en", async () => {
    expect(await renderInvalidReason(SOURCE_REASON, "en")).toBe(
      "The source Inbox item “Buy milk” was deleted, so this proposal can no longer be completed.",
    );
  });

  it("ends a fixable sentence with the offer to choose another target or recompute", async () => {
    expect(await renderInvalidReason(ARCHIVED_REASON, "en")).toBe(
      "The target “Website redesign” was archived, so this proposal has nowhere to go. Choose another target or ask Semp to recompute.",
    );
    expect(await renderInvalidReason(ARCHIVED_REASON, "cs")).toBe(
      "Cíl „Website redesign“ byl archivován, takže návrh nemá kam zapsat. Vyberte jiný cíl nebo požádejte Semp o nový výpočet.",
    );
    const deleted: InvalidReason = { ...ARCHIVED_REASON, code: "targetDeleted" };
    expect(await renderInvalidReason(deleted, "en")).toBe(
      "The target “Website redesign” was deleted, so this proposal has nowhere to go. Choose another target or ask Semp to recompute.",
    );
    expect(await renderInvalidReason(deleted, "cs")).toBe(
      "Cíl „Website redesign“ byl smazán, takže návrh nemá kam zapsat. Vyberte jiný cíl nebo požádejte Semp o nový výpočet.",
    );
  });

  it("falls back to English for a locale without a catalog", async () => {
    expect(await renderInvalidReason(SOURCE_REASON, "de")).toBe(await renderInvalidReason(SOURCE_REASON, "en"));
  });

  it("inserts the label verbatim, so a $ in it is not read as a replacement pattern", async () => {
    const sentence = await renderInvalidReason({ ...SOURCE_REASON, label: "Pay $& tax $1" }, "en");
    expect(sentence).toContain("“Pay $& tax $1”");
  });
});
