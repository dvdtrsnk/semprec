import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AccountOperations, TenantExport } from "../../../api/accountOperations.js";
import { AccountPage } from "../AccountPage.js";

function makeExport(overrides: Partial<TenantExport> = {}): TenantExport {
  return {
    id: "export-1",
    status: "ready",
    createdAt: "2026-10-18T10:00:00.000Z",
    completedAt: "2026-10-18T10:05:00.000Z",
    expiresAt: "2026-10-25T10:05:00.000Z",
    byteSize: 2048,
    ...overrides,
  };
}

function makeOperations(overrides: Partial<AccountOperations> = {}): AccountOperations {
  return {
    listExports: vi.fn(async (): Promise<TenantExport[]> => []),
    requestExport: vi.fn(async () => makeExport({ status: "pending" })),
    exportDownloadUrl: vi.fn((id: string) => `/api/account/exports/${encodeURIComponent(id)}/download`),
    deleteAccount: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPage(operations: AccountOperations, onAccountDeleted = vi.fn()) {
  render(
    <I18nProvider locale="en">
      <AccountPage operations={operations} onAccountDeleted={onAccountDeleted} />
    </I18nProvider>,
  );
  return { onAccountDeleted };
}

afterEach(() => {
  cleanup();
});

describe("AccountPage exports", () => {
  it("requests an export and reloads the list", async () => {
    const listExports = vi
      .fn<() => Promise<TenantExport[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeExport({ status: "pending" })]);
    const operations = makeOperations({ listExports });
    renderPage(operations);

    await screen.findByText("You have no exports yet");
    await userEvent.click(screen.getByRole("button", { name: "Request export" }));

    await waitFor(() => expect(listExports).toHaveBeenCalledTimes(2));
    expect(operations.requestExport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Pending")).toBeInTheDocument();
  });

  it("shows a rejected export request in an alert and keeps the list", async () => {
    const operations = makeOperations({
      requestExport: vi.fn(async () => {
        throw new OperationError("retryable", "rate_limited", 429);
      }),
    });
    renderPage(operations);

    await userEvent.click(await screen.findByRole("button", { name: "Request export" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The export could not be requested: rate_limited");
    expect(screen.getByText("You have no exports yet")).toBeInTheDocument();
  });

  it("links only a ready export to its download URL, with its expiry", async () => {
    const operations = makeOperations({
      listExports: vi.fn(async () => [
        makeExport({ id: "ready-1", status: "ready" }),
        makeExport({ id: "running-1", status: "running", expiresAt: null }),
      ]),
    });
    renderPage(operations);

    const download = await screen.findByRole("link", { name: "Download" });
    expect(download).toHaveAttribute("href", "/api/account/exports/ready-1/download");
    expect(download).toHaveAttribute("download");
    expect(operations.exportDownloadUrl).toHaveBeenCalledWith("ready-1");
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Download" })).toHaveLength(1);
  });

  it("reloads the list on Refresh", async () => {
    const listExports = vi.fn(async (): Promise<TenantExport[]> => []);
    renderPage(makeOperations({ listExports }));

    await screen.findByText("You have no exports yet");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(listExports).toHaveBeenCalledTimes(2));
  });

  it("shows the error state for a failed list load and reloads on retry", async () => {
    const listExports = vi
      .fn<() => Promise<TenantExport[]>>()
      .mockRejectedValueOnce(new OperationError("retryable", "down", 500))
      .mockResolvedValueOnce([makeExport({ status: "failed" })]);
    renderPage(makeOperations({ listExports }));

    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(listExports).toHaveBeenCalledTimes(2);
  });
});

describe("AccountPage deletion", () => {
  it("calls deleteAccount with the password and ends the session on success", async () => {
    const operations = makeOperations();
    const { onAccountDeleted } = renderPage(operations);

    await userEvent.type(screen.getByLabelText("Password"), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    await waitFor(() => expect(onAccountDeleted).toHaveBeenCalledTimes(1));
    expect(operations.deleteAccount).toHaveBeenCalledWith("correct horse");
  });

  it("shows the wrong-password message and clears the field on a 403", async () => {
    const operations = makeOperations({
      deleteAccount: vi.fn(async () => {
        throw new OperationError("unavailable", "reauthentication_failed", 403);
      }),
    });
    const { onAccountDeleted } = renderPage(operations);

    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The password is incorrect. Enter it again.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(onAccountDeleted).not.toHaveBeenCalled();
  });

  it("shows the last-admin message on a last_admin rejection and does not end the session", async () => {
    const operations = makeOperations({
      deleteAccount: vi.fn(async () => {
        throw new OperationError("retryable", "last_admin", 409);
      }),
    });
    const { onAccountDeleted } = renderPage(operations);

    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You are the last admin");
    expect(onAccountDeleted).not.toHaveBeenCalled();
  });

  it("names any other failure with its message and keeps the session", async () => {
    const operations = makeOperations({
      deleteAccount: vi.fn(async () => {
        throw new OperationError("retryable", "boom", 500);
      }),
    });
    const { onAccountDeleted } = renderPage(operations);

    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The account could not be deleted: boom");
    expect(onAccountDeleted).not.toHaveBeenCalled();
  });
});
