import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { InvitationOperations } from "../../../api/invitationOperations.js";
import { InvitationAcceptPage } from "../InvitationAcceptPage.js";

const PASSWORD = "correct horse battery staple";
const INVALID_LINK = "This invitation link is invalid, has expired, has been revoked or has already been used.";

function stubOperations(overrides: Partial<InvitationOperations> = {}): InvitationOperations {
  return {
    acceptInvitation: vi.fn(async () => ({ email: "invitee@example.com" })),
    ...overrides,
  };
}

function renderPage(token: string | null, operations: InvitationOperations) {
  return render(
    <I18nProvider locale="en">
      <InvitationAcceptPage token={token} operations={operations} />
    </I18nProvider>,
  );
}

async function fillAndSubmit(password: string) {
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("InvitationAcceptPage (issue #1088)", () => {
  const originalUrl = window.location.href;

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", originalUrl);
  });

  it("clears the fragment from the address bar on mount without adding a history entry, and submits the token", async () => {
    window.history.replaceState(null, "", "/?page=invite#token=abc");
    const lengthBeforeRender = window.history.length;
    const operations = stubOperations();

    renderPage("abc", operations);

    expect(window.location.search).toBe("?page=invite");
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(lengthBeforeRender);

    await fillAndSubmit(PASSWORD);

    expect(operations.acceptInvitation).toHaveBeenCalledWith({ token: "abc", password: PASSWORD });
  });

  it("shows the success state with the created email and a link to login", async () => {
    renderPage("abc", stubOperations());

    await fillAndSubmit(PASSWORD);

    expect(await screen.findByText("The account for invitee@example.com has been created.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "?page=login");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("shows the single invalid-link message and no form when the token is unusable (404)", async () => {
    const operations = stubOperations({
      acceptInvitation: vi.fn(async () => {
        throw new OperationError("unavailable", "Not found", 404);
      }),
    });
    renderPage("abc", operations);

    await fillAndSubmit(PASSWORD);

    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
  });

  it("keeps the form enabled and shows a retryable failure in an alert", async () => {
    const operations = stubOperations({
      acceptInvitation: vi.fn(async () => {
        throw new OperationError("retryable", "password must be at least 8 characters", 400);
      }),
    });
    renderPage("abc", operations);

    await fillAndSubmit("short");

    expect(await screen.findByRole("alert")).toHaveTextContent("password must be at least 8 characters");
    expect(screen.getByLabelText("Password")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("disables the password field and the button while the request is pending", async () => {
    let settle: (value: { email: string }) => void = () => undefined;
    const pending = new Promise<{ email: string }>((resolve) => {
      settle = resolve;
    });
    renderPage("abc", stubOperations({ acceptInvitation: vi.fn(() => pending) }));

    await fillAndSubmit(PASSWORD);

    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating account…" })).toBeDisabled();

    settle({ email: "invitee@example.com" });
    expect(await screen.findByText("The account for invitee@example.com has been created.")).toBeInTheDocument();
  });

  it("shows the invalid-link message and never calls the API when there is no token", async () => {
    const operations = stubOperations();
    renderPage(null, operations);

    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_LINK);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(operations.acceptInvitation).not.toHaveBeenCalled();
  });
});
