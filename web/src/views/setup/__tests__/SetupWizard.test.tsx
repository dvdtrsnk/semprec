import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { SetupOperations, SetupPublicUser } from "../../../api/setupOperations.js";
import { SetupWizard } from "../SetupWizard.js";

const TOKEN = "bootstrap-token";

function stubOperations(overrides: Partial<SetupOperations> = {}): SetupOperations {
  return {
    setupAccount: vi.fn(async (): Promise<SetupPublicUser> => ({
      id: "user-1",
      email: "operator@example.com",
      locale: "en",
      createdAt: "2026-09-01T12:00:00.000Z",
    })),
    ...overrides,
  };
}

function renderWizard(operations: SetupOperations) {
  return render(
    <I18nProvider locale="en">
      <SetupWizard token={TOKEN} operations={operations} />
    </I18nProvider>,
  );
}

async function fillAndSubmit(email: string, password: string) {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("SetupWizard (issue #234)", () => {
  afterEach(() => cleanup());

  it("shows the form and submits email, password, and token to the setup API", async () => {
    const setupAccount = vi.fn(async (): Promise<SetupPublicUser> => ({
      id: "user-1",
      email: "operator@example.com",
      locale: "en",
      createdAt: "2026-09-01T12:00:00.000Z",
    }));
    renderWizard(stubOperations({ setupAccount }));

    await fillAndSubmit("operator@example.com", "correct horse battery staple");

    expect(setupAccount).toHaveBeenCalledWith({
      token: TOKEN,
      email: "operator@example.com",
      password: "correct horse battery staple",
    });
  });

  it("shows a success state with a link to login after account creation", async () => {
    renderWizard(stubOperations());

    await fillAndSubmit("operator@example.com", "correct horse battery staple");

    expect(await screen.findByText("Your account has been created.")).toBeInTheDocument();
    const loginLink = screen.getByRole("link", { name: "Continue to login" });
    expect(loginLink).toHaveAttribute("href", "?page=login");
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("shows a not-found state with no form when the API returns 404", async () => {
    const setupAccount = vi.fn(async () => {
      throw new OperationError("unavailable", "Not found", 404);
    });
    renderWizard(stubOperations({ setupAccount }));

    await fillAndSubmit("operator@example.com", "correct horse battery staple");

    expect(await screen.findByText("This setup link is no longer valid.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
  });

  it("shows a retryable error inline and keeps the form for a validation failure", async () => {
    const setupAccount = vi.fn(async () => {
      throw new OperationError("retryable", "'password' must be at least 8 characters", 400);
    });
    renderWizard(stubOperations({ setupAccount }));

    await fillAndSubmit("operator@example.com", "short");

    expect(await screen.findByText("'password' must be at least 8 characters")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("does not create an account itself: only the injected operation is called", async () => {
    const setupAccount = vi.fn(async (): Promise<SetupPublicUser> => ({
      id: "user-1",
      email: "operator@example.com",
      locale: "en",
      createdAt: "2026-09-01T12:00:00.000Z",
    }));
    renderWizard(stubOperations({ setupAccount }));

    await fillAndSubmit("operator@example.com", "correct horse battery staple");

    expect(setupAccount).toHaveBeenCalledTimes(1);
  });
});
