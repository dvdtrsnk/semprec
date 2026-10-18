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
    deleteAccount: vi.fn(async () => account({ status: "deleting" })),
    changeRole: vi.fn(async () => account({ role: "admin" })),
    listInvites: vi.fn(async () => []),
    createInvite: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    revokeInvite: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    listAiBudgets: vi.fn(async () => []),
    setAiBudget: vi.fn(async () => undefined),
    getOperationsHealth: vi.fn(async () => {
      throw new Error("unused");
    }),
    ...overrides,
  };
}

/** The signed-in admin: never a row the panel offers Delete on. */
const CURRENT_USER_ID = "admin-1";

function renderPanel(operations: AdminOperations) {
  render(
    <I18nProvider locale="en">
      <AccountsPanel operations={operations} currentUserId={CURRENT_USER_ID} />
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

describe("AccountsPanel delete", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers Delete on active and suspended rows of other accounts only", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [
        account({ userId: "user-2", email: "active@example.com", status: "active" }),
        account({ userId: "user-3", email: "suspended@example.com", status: "suspended" }),
        account({ userId: "user-4", email: "provisioning@example.com", status: "provisioning" }),
        account({ userId: "user-5", email: "deleting@example.com", status: "deleting" }),
        account({ userId: CURRENT_USER_ID, email: "self@example.com", role: "admin", status: "active" }),
      ]),
    });
    renderPanel(operations);

    expect(
      within(await screen.findByRole("row", { name: /active@example.com/ })).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
    expect(within(rowFor("suspended@example.com")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(
      within(rowFor("provisioning@example.com")).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(within(rowFor("deleting@example.com")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowFor("self@example.com")).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(rowFor("self@example.com")).getByRole("button", { name: "Suspend" })).toBeInTheDocument();
  });

  it("shows the confirmation naming the email and sends no request; Cancel restores the row", async () => {
    const operations = stubOperations();
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      screen.getByText("Permanently delete member@example.com and all of its data? This cannot be undone."),
    ).toBeInTheDocument();
    expect(operations.deleteAccount).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(operations.deleteAccount).not.toHaveBeenCalled();
    expect(screen.queryByText(/Permanently delete/)).not.toBeInTheDocument();
    expect(within(rowFor("member@example.com")).getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    expect(within(rowFor("member@example.com")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("holds one confirmation at a time: opening another row's confirmation closes the first", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [
        account({ userId: "user-2", email: "first@example.com" }),
        account({ userId: "user-3", email: "second@example.com" }),
      ]),
    });
    renderPanel(operations);

    await userEvent.click((await screen.findAllByRole("button", { name: "Delete" }))[0]!);
    await userEvent.click(within(rowFor("second@example.com")).getByRole("button", { name: "Delete" }));

    expect(
      screen.getByText("Permanently delete second@example.com and all of its data? This cannot be undone."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Permanently delete first@example.com/)).not.toBeInTheDocument();
    expect(within(rowFor("first@example.com")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(operations.deleteAccount).not.toHaveBeenCalled();
  });

  it("confirming calls deleteAccount once with the userId and reloads the list", async () => {
    const operations = stubOperations();
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(operations.deleteAccount).toHaveBeenCalledTimes(1);
    expect(operations.deleteAccount).toHaveBeenCalledWith("user-2");
    await vi.waitFor(() => expect(operations.listAccounts).toHaveBeenCalledTimes(2));
  });

  it("disables the confirmation while the delete is pending", async () => {
    let finish: (value: AdminAccountSummary) => void = () => undefined;
    const operations = stubOperations({
      deleteAccount: vi.fn(
        () =>
          new Promise<AdminAccountSummary>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    finish(account({ status: "deleting" }));

    await vi.waitFor(() => expect(operations.listAccounts).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Permanently delete/)).not.toBeInTheDocument();
  });

  it("keeps another row's confirmation when a pending delete succeeds", async () => {
    let finish: (value: AdminAccountSummary) => void = () => undefined;
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [
        account({ userId: "user-2", email: "first@example.com" }),
        account({ userId: "user-3", email: "second@example.com" }),
      ]),
      deleteAccount: vi.fn(
        () =>
          new Promise<AdminAccountSummary>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    renderPanel(operations);

    await userEvent.click((await screen.findAllByRole("button", { name: "Delete" }))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await userEvent.click(within(rowFor("second@example.com")).getByRole("button", { name: "Delete" }));

    finish(account({ userId: "user-2", email: "first@example.com", status: "deleting" }));

    await vi.waitFor(() => expect(operations.listAccounts).toHaveBeenCalledTimes(2));
    expect(
      screen.getByText("Permanently delete second@example.com and all of its data? This cannot be undone."),
    ).toBeInTheDocument();
  });

  it("keeps another row's confirmation when a pending delete is refused", async () => {
    let refuse: (error: Error) => void = () => undefined;
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [
        account({ userId: "user-2", email: "first@example.com" }),
        account({ userId: "user-3", email: "second@example.com" }),
      ]),
      deleteAccount: vi.fn(
        () =>
          new Promise<AdminAccountSummary>((_resolve, reject) => {
            refuse = reject;
          }),
      ),
    });
    renderPanel(operations);

    await userEvent.click((await screen.findAllByRole("button", { name: "Delete" }))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await userEvent.click(within(rowFor("second@example.com")).getByRole("button", { name: "Delete" }));

    refuse(new OperationError("retryable", "boom", 500));

    expect(await screen.findByRole("alert")).toHaveTextContent("The change failed: boom");
    expect(
      screen.getByText("Permanently delete second@example.com and all of its data? This cannot be undone."),
    ).toBeInTheDocument();
    expect(operations.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows the last-admin message on refusal, closes the confirmation and keeps the row's status", async () => {
    const operations = stubOperations({
      listAccounts: vi.fn(async () => [account({ role: "admin", email: "last@example.com" })]),
      deleteAccount: vi.fn(async () => {
        throw new OperationError("retryable", "last_admin", 409);
      }),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("At least one active admin must remain");
    const row = rowFor("last@example.com");
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.queryByText(/Permanently delete/)).not.toBeInTheDocument();
    expect(operations.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows any other rejection's message, closes the confirmation and keeps the row's status", async () => {
    const operations = stubOperations({
      deleteAccount: vi.fn(async () => {
        throw new OperationError("retryable", "boom", 500);
      }),
    });
    renderPanel(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The change failed: boom");
    expect(within(rowFor("member@example.com")).getByText("Active")).toBeInTheDocument();
    expect(within(rowFor("member@example.com")).getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(operations.listAccounts).toHaveBeenCalledTimes(1);
  });
});
