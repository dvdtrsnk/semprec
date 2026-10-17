import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AuthOperations } from "../../../api/authOperations.js";
import { PasswordResetPage } from "../PasswordResetPage.js";

function stubAuth(overrides: Partial<AuthOperations> = {}): AuthOperations {
  return {
    login: vi.fn(async () => {
      throw new Error("not used");
    }),
    getSession: vi.fn(async () => null),
    logout: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async () => undefined),
    resetPassword: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPage(token: string | null, auth: AuthOperations) {
  render(
    <I18nProvider locale="en">
      <PasswordResetPage token={token} auth={auth} />
    </I18nProvider>,
  );
}

describe("PasswordResetPage", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  describe("without a token", () => {
    it("posts the entered email and shows a confirmation that does not say whether the address has an account", async () => {
      const auth = stubAuth();
      renderPage(null, auth);

      await userEvent.type(screen.getByLabelText("Email"), "operator@example.com");
      await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

      expect(auth.requestPasswordReset).toHaveBeenCalledWith("operator@example.com");
      expect(await screen.findByRole("status")).toHaveTextContent(
        "If an account exists for this email address, a password reset link has been sent to it.",
      );
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    });

    it("keeps the form and shows the failure message in an alert when the request is rejected", async () => {
      const auth = stubAuth({
        requestPasswordReset: vi.fn(async () => {
          throw new OperationError("retryable", "Too many requests", 429);
        }),
      });
      renderPage(null, auth);

      await userEvent.type(screen.getByLabelText("Email"), "operator@example.com");
      await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Sending the reset link failed: Too many requests");
      expect(screen.getByLabelText("Email")).toHaveValue("operator@example.com");
      expect(screen.getByLabelText("Email")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Send reset link" })).toBeEnabled();
    });
  });

  describe("with a token", () => {
    it("removes the fragment from the address bar on mount without adding a history entry", async () => {
      window.history.replaceState(null, "", "/?page=password-reset#token=abc");
      const historyLength = window.history.length;

      renderPage("abc", stubAuth());

      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe("?page=password-reset");
      expect(window.location.href).not.toContain("#");
      expect(window.history.length).toBe(historyLength);
    });

    it("submits the new password with the token it received, after the fragment is gone", async () => {
      window.history.replaceState(null, "", "/?page=password-reset#token=abc");
      const auth = stubAuth();
      renderPage("abc", auth);

      await userEvent.type(screen.getByLabelText("New password"), "a new password");
      await userEvent.click(screen.getByRole("button", { name: "Set new password" }));

      expect(auth.resetPassword).toHaveBeenCalledWith({ token: "abc", newPassword: "a new password" });
      expect(window.location.hash).toBe("");
    });

    it("shows the success state with a link to the login page", async () => {
      renderPage("abc", stubAuth());

      await userEvent.type(screen.getByLabelText("New password"), "a new password");
      await userEvent.click(screen.getByRole("button", { name: "Set new password" }));

      expect(await screen.findByRole("status")).toHaveTextContent(
        "Your password has been changed and every session was signed out.",
      );
      expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "?page=login");
    });

    it("shows the invalid-link state with a link to request a new one when the token is rejected as unavailable", async () => {
      const auth = stubAuth({
        resetPassword: vi.fn(async () => {
          throw new OperationError("unavailable", "Reset link is not valid", 400);
        }),
      });
      renderPage("abc", auth);

      await userEvent.type(screen.getByLabelText("New password"), "a new password");
      await userEvent.click(screen.getByRole("button", { name: "Set new password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This reset link is invalid, has expired or has already been used.",
      );
      expect(screen.getByRole("link", { name: "Request a new reset link" })).toHaveAttribute(
        "href",
        "?page=password-reset",
      );
      expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    });

    it("keeps the form enabled with the message when the failure is retryable, so the same token can be resubmitted", async () => {
      const auth = stubAuth({
        resetPassword: vi.fn(async () => {
          throw new OperationError("retryable", "password must be at least 8 characters", 400);
        }),
      });
      renderPage("abc", auth);

      await userEvent.type(screen.getByLabelText("New password"), "short");
      await userEvent.click(screen.getByRole("button", { name: "Set new password" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Setting the new password failed: password must be at least 8 characters",
      );
      expect(screen.getByLabelText("New password")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Set new password" })).toBeEnabled();

      await userEvent.click(screen.getByRole("button", { name: "Set new password" }));
      expect(auth.resetPassword).toHaveBeenCalledTimes(2);
      expect(auth.resetPassword).toHaveBeenLastCalledWith({ token: "abc", newPassword: "short" });
    });
  });
});
