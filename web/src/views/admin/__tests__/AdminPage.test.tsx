import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../../i18n/index.js";
import type { AdminOperations } from "../../../api/adminOperations.js";
import { AdminPage } from "../AdminPage.js";

function stubOperations(): AdminOperations {
  return {
    listAccounts: vi.fn(async () => []),
    suspendAccount: vi.fn(async () => {
      throw new Error("unused");
    }),
    reactivateAccount: vi.fn(async () => {
      throw new Error("unused");
    }),
    changeRole: vi.fn(async () => {
      throw new Error("unused");
    }),
    listInvites: vi.fn(async () => []),
    createInvite: vi.fn(async () => {
      throw new Error("unused");
    }),
    revokeInvite: vi.fn(async () => {
      throw new Error("unused");
    }),
    listAiBudgets: vi.fn(async () => []),
    setAiBudget: vi.fn(async () => undefined),
  };
}

describe("AdminPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the invitations panel after the accounts panel", async () => {
    render(
      <I18nProvider locale="en">
        <AdminPage operations={stubOperations()} />
      </I18nProvider>,
    );

    // With no accounts the accounts panel renders its empty state, which is the element that precedes the invitations panel.
    const accounts = await screen.findByText("No accounts yet");
    const invitations = await screen.findByRole("heading", { name: "Invitations" });
    expect(accounts.compareDocumentPosition(invitations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create invitation" })).toBeInTheDocument();
  });

  it("renders the AI budgets panel after the invitations panel", async () => {
    render(
      <I18nProvider locale="en">
        <AdminPage operations={stubOperations()} />
      </I18nProvider>,
    );

    const invitations = await screen.findByRole("heading", { name: "Invitations" });
    const budgets = await screen.findByRole("heading", { name: "AI budgets" });
    expect(invitations.compareDocumentPosition(budgets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
