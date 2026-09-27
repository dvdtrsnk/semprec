import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AuthOperations, SessionUser } from "../../../api/authOperations.js";
import { LoginPage } from "../LoginPage.js";

const USER: SessionUser = {
  id: "user-1",
  email: "operator@example.com",
  locale: "en",
  createdAt: "2026-09-01T12:00:00.000Z",
};

function stubAuth(login: AuthOperations["login"]): AuthOperations {
  return { login, getSession: vi.fn(async () => null), logout: vi.fn(async () => undefined) };
}

function renderPage(auth: AuthOperations, onLoggedIn = vi.fn()) {
  render(
    <I18nProvider locale="en">
      <LoginPage auth={auth} onLoggedIn={onLoggedIn} />
    </I18nProvider>,
  );
  return onLoggedIn;
}

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText("Email"), "operator@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPage", () => {
  afterEach(() => cleanup());

  it("submits the credentials and hands the parsed user to onLoggedIn", async () => {
    const login = vi.fn(async () => USER);
    const onLoggedIn = renderPage(stubAuth(login));

    await fillAndSubmit();

    expect(login).toHaveBeenCalledWith({ email: "operator@example.com", password: "correct horse" });
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(onLoggedIn).toHaveBeenCalledWith(USER);
  });

  it("shows the invalid-credentials message on a 401 and keeps the form enabled", async () => {
    const onLoggedIn = renderPage(
      stubAuth(async () => {
        throw new OperationError("unavailable", "Invalid or missing credentials", 401);
      }),
    );

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is not correct");
    expect(screen.getByLabelText("Email")).toBeEnabled();
    expect(screen.getByLabelText("Email")).toHaveValue("operator@example.com");
    expect(screen.getByLabelText("Password")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it("shows the failure message for any other error", async () => {
    const onLoggedIn = renderPage(
      stubAuth(async () => {
        throw new OperationError("retryable", "Request to /auth/login failed with 503", 503);
      }),
    );

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Signing in failed: Request to /auth/login failed with 503",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it("disables the controls and shows the submitting label while the login is pending", async () => {
    let resolve: (user: SessionUser) => void = () => undefined;
    const onLoggedIn = renderPage(stubAuth(() => new Promise<SessionUser>((settle) => (resolve = settle))));

    await fillAndSubmit();

    const button = await screen.findByRole("button", { name: "Signing in…" });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();

    resolve(USER);
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(USER));
  });
});
