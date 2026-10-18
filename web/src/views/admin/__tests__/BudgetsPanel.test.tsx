import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AdminOperations, AiBudgetAccount } from "../../../api/adminOperations.js";
import { BudgetsPanel } from "../BudgetsPanel.js";

function account(overrides: Partial<AiBudgetAccount> = {}): AiBudgetAccount {
  return {
    userId: "user-2",
    email: "member@example.com",
    hasBudget: true,
    dailyCapUsd: 5,
    monthlyCapUsd: 40,
    spentTodayUsd: 1.5,
    spentMonthUsd: 12.25,
    ...overrides,
  };
}

function stubOperations(overrides: Partial<AdminOperations> = {}): AdminOperations {
  return {
    listAccounts: vi.fn(async () => []),
    suspendAccount: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    reactivateAccount: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    changeRole: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    listInvites: vi.fn(async () => []),
    createInvite: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    revokeInvite: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    listAiBudgets: vi.fn(async (): Promise<AiBudgetAccount[]> => [account()]),
    setAiBudget: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPanel(operations: AdminOperations) {
  return render(
    <I18nProvider locale="en">
      <BudgetsPanel operations={operations} />
    </I18nProvider>,
  );
}

/** The table row that shows one account's email, so assertions stay on that row only. Call after the list has loaded. */
function rowFor(email: string): HTMLElement {
  return screen.getByText(email).closest("tr") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BudgetsPanel rendering", () => {
  it("lists every account with its email, both caps and both spend values formatted as USD", async () => {
    renderPanel(
      stubOperations({
        listAiBudgets: vi.fn(async () => [
          account({ userId: "u1", email: "one@example.com" }),
          account({
            userId: "u2",
            email: "two@example.com",
            dailyCapUsd: 0.5,
            monthlyCapUsd: 10,
            spentTodayUsd: 0,
            spentMonthUsd: 3,
          }),
        ]),
      }),
    );

    await screen.findByText("one@example.com");
    const first = within(rowFor("one@example.com"));
    expect(first.getByText("$5.00")).toBeInTheDocument();
    expect(first.getByText("$40.00")).toBeInTheDocument();
    expect(first.getByText("$1.50")).toBeInTheDocument();
    expect(first.getByText("$12.25")).toBeInTheDocument();

    const second = within(rowFor("two@example.com"));
    expect(second.getByText("$0.50")).toBeInTheDocument();
    expect(second.getByText("$10.00")).toBeInTheDocument();
    expect(second.getByText("$0.00")).toBeInTheDocument();
    expect(second.getByText("$3.00")).toBeInTheDocument();
  });

  it("shows the no-budget state instead of caps for an account without a budget row", async () => {
    renderPanel(
      stubOperations({
        listAiBudgets: vi.fn(async () => [account({ hasBudget: false, dailyCapUsd: null, monthlyCapUsd: null })]),
      }),
    );

    expect(await screen.findByText("No budget — AI requests are refused")).toBeInTheDocument();
    expect(screen.queryByText("No cap")).not.toBeInTheDocument();
  });

  it("shows the uncapped state for a null cap on a row that has a budget", async () => {
    renderPanel(
      stubOperations({
        listAiBudgets: vi.fn(async () => [account({ dailyCapUsd: 5, monthlyCapUsd: null })]),
      }),
    );

    expect(await screen.findByText("No cap")).toBeInTheDocument();
    expect(within(rowFor("member@example.com")).getByText("$5.00")).toBeInTheDocument();
  });

  it("shows its empty state when no accounts come back", async () => {
    renderPanel(stubOperations({ listAiBudgets: vi.fn(async () => []) }));

    expect(await screen.findByText("No accounts to show budgets for")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the error state when the initial load fails, and its retry reloads the list", async () => {
    const listAiBudgets = vi
      .fn<AdminOperations["listAiBudgets"]>()
      .mockRejectedValueOnce(new OperationError("retryable", "boom"))
      .mockResolvedValueOnce([account()]);
    renderPanel(stubOperations({ listAiBudgets }));

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("member@example.com")).toBeInTheDocument();
    expect(listAiBudgets).toHaveBeenCalledTimes(2);
  });
});

describe("BudgetsPanel editing", () => {
  it("saves a daily cap with an empty monthly field as null, closes the form and reloads the list", async () => {
    const operations = stubOperations({
      listAiBudgets: vi.fn(async () => [account({ dailyCapUsd: null, monthlyCapUsd: null })]),
    });
    renderPanel(operations);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit caps" }));
    await user.type(screen.getByLabelText("Daily cap"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(operations.setAiBudget).toHaveBeenCalledWith("user-2", { dailyCapUsd: 5, monthlyCapUsd: null }),
    );
    await vi.waitFor(() => expect(operations.listAiBudgets).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("Daily cap")).not.toBeInTheDocument();
  });

  it("rejects a negative cap with the invalid message and sends no request", async () => {
    const operations = stubOperations();
    renderPanel(operations);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit caps" }));
    const daily = screen.getByLabelText("Daily cap");
    await user.clear(daily);
    await user.type(daily, "-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Each cap must be empty or a number that is zero or greater",
    );
    expect(operations.setAiBudget).not.toHaveBeenCalled();
  });

  it("keeps the form and the typed values when the save is refused, and shows the message in an alert", async () => {
    const operations = stubOperations({
      setAiBudget: vi.fn(async () => {
        throw new OperationError("retryable", "validation_failed");
      }),
    });
    renderPanel(operations);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit caps" }));
    const daily = screen.getByLabelText("Daily cap");
    await user.clear(daily);
    await user.type(daily, "7");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The budget could not be saved: validation_failed");
    expect(screen.getByLabelText("Daily cap")).toHaveValue(7);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(operations.listAiBudgets).toHaveBeenCalledTimes(1);
  });
});
