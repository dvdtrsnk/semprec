import { describe, expect, it } from "vitest";
import { aiUsageReportSchema } from "../aiUsageOperations.js";

function makeReport(overrides: Partial<{ from: string; to: string }> = {}): unknown {
  const now = new Date().toISOString();
  return {
    from: now,
    to: now,
    rows: [],
    totalCostUsd: 0,
    dailyCostUsd: [],
    dailyTokenUsage: [],
    budgets: { dailyBudgetUsd: null, monthlyBudgetUsd: null },
    ...overrides,
  };
}

describe("aiUsageReportSchema", () => {
  it("accepts a report whose from/to are ISO-8601 datetimes", () => {
    expect(aiUsageReportSchema.safeParse(makeReport()).success).toBe(true);
  });

  it("rejects a report whose from is not an ISO-8601 datetime", () => {
    const result = aiUsageReportSchema.safeParse(makeReport({ from: "27. 9. 2026" }));
    expect(result.success).toBe(false);
  });
});
