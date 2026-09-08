import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import type { AiUsageOperations, AiUsageReport } from "../../../api/aiUsageOperations.js";
import { UtilizationPage } from "../UtilizationPage.js";

function makeReport(overrides: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    from: "2026-08-08T00:00:00.000Z",
    to: "2026-09-07T00:00:00.000Z",
    rows: [
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        nativeUnit: "tokens",
        runUnit: "invocation",
        callCount: 4,
        costUsd: 3.5,
        inputTokens: 400,
        outputTokens: 120,
        audioSeconds: null,
      },
      {
        provider: "deepinfra",
        model: "whisper-large-v3",
        nativeUnit: "audio_seconds",
        runUnit: null,
        callCount: 1,
        costUsd: 0.05,
        inputTokens: null,
        outputTokens: null,
        audioSeconds: 100,
      },
    ],
    totalCostUsd: 3.55,
    dailyCostUsd: [
      { day: "2026-09-05", costUsd: 1 },
      { day: "2026-09-06", costUsd: 60 },
    ],
    dailyTokenUsage: [
      { day: "2026-09-05", inputTokens: 100, outputTokens: 20 },
      { day: "2026-09-06", inputTokens: 300, outputTokens: 100 },
    ],
    budgets: { dailyBudgetUsd: 50, monthlyBudgetUsd: null },
    ...overrides,
  };
}

function stubOperations(getAiUsageReport: AiUsageOperations["getAiUsageReport"]): AiUsageOperations {
  return { getAiUsageReport };
}

function renderPage(operations: AiUsageOperations) {
  return render(
    <I18nProvider locale="en">
      <UtilizationPage operations={operations} />
    </I18nProvider>,
  );
}

describe("UtilizationPage (issue #121)", () => {
  afterEach(() => cleanup());

  it("renders totals, the daily budget, an explicit uncapped monthly budget, and audio-only calls distinctly", async () => {
    renderPage(stubOperations(async () => makeReport()));

    expect(await screen.findByText("AI utilization")).toBeInTheDocument();
    expect(screen.getByText("$3.55")).toBeInTheDocument();
    expect(screen.getByText("Daily budget: $50.00")).toBeInTheDocument();
    expect(screen.getByText("Monthly budget: uncapped")).toBeInTheDocument();
    expect(screen.getByText("100s audio (audio-only, no tokens)")).toBeInTheDocument();
    expect(screen.getByText("400 in / 120 out tokens")).toBeInTheDocument();
    expect(screen.getByText("Not tied to a run")).toBeInTheDocument();
  });

  it("flags a day that exceeded the daily budget", async () => {
    renderPage(stubOperations(async () => makeReport()));

    expect(await screen.findByText("Daily budget exceeded on 1 of the shown days")).toBeInTheDocument();
  });

  it("shows no budget-exceeded note and no daily budget line when the daily budget is unset", async () => {
    renderPage(stubOperations(async () => makeReport({ budgets: { dailyBudgetUsd: null, monthlyBudgetUsd: 200 } })));

    expect(await screen.findByText("No daily budget set")).toBeInTheDocument();
    expect(screen.getByText("Monthly budget: $200.00")).toBeInTheDocument();
    expect(screen.queryByText(/Daily budget exceeded/)).not.toBeInTheDocument();
  });

  it("shows an empty state when there is no usage in the period", async () => {
    renderPage(
      stubOperations(async () => makeReport({ rows: [], dailyCostUsd: [], dailyTokenUsage: [], totalCostUsd: 0 })),
    );

    expect(await screen.findByText("No AI usage in this period")).toBeInTheDocument();
  });

  it("shows an error state and retries on demand", async () => {
    let calls = 0;
    renderPage(
      stubOperations(async () => {
        calls++;
        if (calls === 1) throw new Error("network blip");
        return makeReport({ rows: [], dailyCostUsd: [], dailyTokenUsage: [], totalCostUsd: 0 });
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("network blip");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No AI usage in this period")).toBeInTheDocument();
  });
});
