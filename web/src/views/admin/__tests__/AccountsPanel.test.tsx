import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AdminAccountSummary, AdminOperations } from "../../../api/adminOperations.js";
import { AccountsPanel } from "../AccountsPanel.js";

function account(overrides: Partial<AdminAccountSummary> = {}): AdminAccountSummary {
  return {
    userId: "user-2",
    email: "member@example.com",
    role: "member",
    status: "active",
    createdAt: "2026-09-01T12:00:00.000Z",
    lastSeenAt: null,
    ...overrides,
  };
}

function stubOperations(overrides: Partial<AdminOperations> = {}): AdminOperations {
  return {
    listAccounts: vi.fn(async (): Promise<AdminAccountSummary[]> => [account()]),
    suspendAccount: vi.fn(async () => account({ status: "suspended" })),
    reactivateAccount: vi.fn(async () => account()),
    changeRole: vi.fn(async () => account({ role: "admin" })),
    ...overrides,
  };
}

function renderPanel(operations: AdminOperations) {
  render(
    <I18nProvider locale="en">
      <AccountsPanel operations={operations} />
    </I18nProvider>,
  );
}

function rowFor(email: string): HTMLElement {
  return screen.getByRole("row", { name: new RegExp(email) });
}

describe("AccountsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists email, role, status, created and last seen for each account", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [
        account({ email: "member@example.com", lastSeenAt: null }),
        account({
          userId: "user-3",
          email: "admin@example.com",
          role: "admin",
          lastSeenAt: "2026-09-02T08:30:00.000Z",
        }),
      ]),
    });
    renderPanel(operations);

    const memberRow = await screen.findByRole("row", { name: /member@example.com/ });
    expect(within(memberRow).getByText("Member")).toBeInTheDocument();
    expect(within(memberRow).getByText("Active")).toBeInTheDocument();
    expect(within(memberRow).getByText("—")).toBeInTheDocument();

    const adminRow = rowFor("admin@example.com");
    expect(within(adminRow).getByText("Admin")).toBeInTheDocument();
    expect(within(adminRow).queryByText("—")).not.toBeInTheDocument();
  });

  it("offers only the actions valid for each status", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [
        account({ userId: "a", email: "active@example.com", status: "active" }),
        account({ userId: "b", email: "suspended@example.com", status: "suspended" }),
        account({ userId: "c", email: "provisioning@example.com", status: "provisioning" }),
        account({ userId: "d", email: "deleting@example.com", status: "deleting" }),
      ]),
    });
    renderPanel(operations);

    const activeRow = await screen.findByRole("row", { name: /active@example.com/ });
    expect(within(activeRow).getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    expect(within(activeRow).getByRole("button", { name: "Make admin" })).toBeInTheDocument();
    expect(within(activeRow).queryByRole("button", { name: "Reactivate" })).not.toBeInTheDocument();

    const suspendedRow = rowFor("suspended@example.com");
    expect(within(suspendedRow).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(within(suspendedRow).getByRole("button", { name: "Make admin" })).toBeInTheDocument();
    expect(within(suspendedRow).queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();

    expect(within(rowFor("provisioning@example.com")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowFor("deleting@example.com")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers Make member on an admin row and sends the opposite role", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [account({ role: "admin" })]),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Make member" }));

    expect(operations.changeRole).toHaveBeenCalledWith("user-2", "member");
  });

  it("applies a suspend and reloads the list on success", async () => {
    const operations = stubOperations();
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Suspend" }));

    expect(operations.suspendAccount).toHaveBeenCalledWith("user-2");
    await vi.waitFor(() => expect(operations.listAccounts).toHaveBeenCalledTimes(2));
  });

  it("applies a reactivate to a suspended account and reloads the list on success", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [account({ status: "suspended" })]),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Reactivate" }));

    expect(operations.reactivateAccount).toHaveBeenCalledWith("user-2");
    await vi.waitFor(() => expect(operations.listAccounts).toHaveBeenCalledTimes(2));
  });

  it("applies a role change on success and reloads the list", async () => {
    const operations = stubOperations();
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Make admin" }));

    expect(operations.changeRole).toHaveBeenCalledWith("user-2", "admin");
    await vi.waitFor(() => expect(operations.listAccounts).toHaveBeenCalledTimes(2));
  });

  it("shows the last-admin message and leaves the row as it was", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [account({ role: "admin", email: "last@example.com" })]),
      changeRole: vi.fn(async () => {
        throw new OperationError("retryable", "last_admin", 409);
      }),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Make member" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("At least one active admin must remain");
    const row = rowFor("last@example.com");
    expect(within(row).getByText("Admin")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Make member" })).toBeEnabled();
    expect(operations.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows any other rejection's message and leaves the row as it was", async () => {
    const operations = stubOperations({
      suspendAccount: vi.fn(async () => {
        throw new OperationError("retryable", "boom", 500);
      }),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Suspend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The change failed: boom");
    expect(within(rowFor("member@example.com")).getByRole("button", { name: "Suspend" })).toBeEnabled();
    expect(operations.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("disables the row's buttons while its action is pending", async () => {
    let finish: (value: AdminAccountSummary) => void = () => undefined;
    const operations = stubOperations({
      suspendAccount: vi.fn(
        () =>
          new Promise<AdminAccountSummary>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Suspend" }));

    const row = rowFor("member@example.com");
    expect(within(row).getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Make admin" })).toBeDisabled();
    finish(account({ status: "suspended" }));
  });

  it("shows the error state for a failed load, and its retry reloads the list", async () => {
    const operations = stubOperations({
      listAccounts: vi
        .fn()
        .mockRejectedValueOnce(new OperationError("retryable", "down", 500))
        .mockResolvedValueOnce([account()]),
    });
    renderPanel(operations);

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("row", { name: /member@example.com/ })).toBeInTheDocument();
    expect(operations.listAccounts).toHaveBeenCalledTimes(2);
  });
});
