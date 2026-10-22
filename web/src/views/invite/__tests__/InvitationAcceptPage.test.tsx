import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { InvitationOperations } from "../../../api/invitationOperations.js";
import { InvitationAcceptPage } from "../InvitationAcceptPage.js";

const PASSWORD = "correct horse battery staple";
const INVALID_MESSAGE = "This invitation link is invalid, has expired, was revoked or has already been used.";

function stubOperations(
  acceptInvitation: InvitationOperations["acceptInvitation"] = vi.fn(async () => ({ email: "invitee@example.com" })),
): InvitationOperations & { acceptInvitation: ReturnType<typeof vi.fn> } {
  return { acceptInvitation: vi.fn(acceptInvitation) };
}

function renderPage(token: string | null, operations: InvitationOperations) {
  return render(
    <I18nProvider locale="en">
      <InvitationAcceptPage token={token} operations={operations} />
    </I18nProvider>,
  );
}

async function submitPassword(password: string) {
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("InvitationAcceptPage (issue #1088)", () => {
  const originalUrl = window.location.href;

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", originalUrl);
  });

  it("clears the fragment on mount without adding a history entry and still submits the token prop", async () => {
    window.history.replaceState(null, "", "/?page=invite#token=abc");
    const lengthBeforeRender = window.history.length;
    const operations = stubOperations();

    renderPage("abc", operations);

    expect(window.location.pathname + window.location.search).toBe("/?page=invite");
    expect(window.location.hash).toBe("");
    expect(window.location.href.endsWith("#")).toBe(false);
    expect(window.history.length).toBe(lengthBeforeRender);

    await submitPassword(PASSWORD);

    expect(operations.acceptInvitation).toHaveBeenCalledTimes(1);
    expect(operations.acceptInvitation).toHaveBeenCalledWith({ token: "abc", password: PASSWORD });
  });

  it("renders the password field as a required new-password input", () => {
    renderPage("abc", stubOperations());

    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "new-password");
    expect(input).toBeRequired();
  });

  it("disables the field and the button while the request is pending", async () => {
    let resolve: (value: { email: string }) => void = () => undefined;
    const operations = stubOperations(
      () =>
        new Promise<{ email: string }>((r) => {
          resolve = r;
        }),
    );
    renderPage("abc", operations);

    await submitPassword(PASSWORD);

    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating account…" })).toBeDisabled();
    resolve({ email: "invitee@example.com" });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows the success state with the created account's email and a link to the login page", async () => {
    renderPage("abc", stubOperations());

    await submitPassword(PASSWORD);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The account invitee@example.com has been created. Sign in to continue.",
    );
    expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "?page=login");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("shows the single invalid-link message and no form when the token is rejected with 404", async () => {
    const operations = stubOperations(async () => {
      throw new OperationError("unavailable", "Not found", 404);
    });
    renderPage("abc", operations);

    await submitPassword(PASSWORD);

    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_MESSAGE);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the form enabled and shows a retryable failure's message in an alert", async () => {
    const operations = stubOperations(async () => {
      throw new OperationError("retryable", "'password' must be at least 8 characters", 400);
    });
    renderPage("abc", operations);

    await submitPassword("short");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Creating the account failed: 'password' must be at least 8 characters",
    );
    expect(screen.getByLabelText("Password")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
    expect(screen.queryByText(INVALID_MESSAGE)).not.toBeInTheDocument();
  });

  it("shows the invalid-link state immediately and never calls acceptInvitation without a token", () => {
    const operations = stubOperations();

    renderPage(null, operations);

    expect(screen.getByRole("alert")).toHaveTextContent(INVALID_MESSAGE);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(operations.acceptInvitation).not.toHaveBeenCalled();
  });
});
