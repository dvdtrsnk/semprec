import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OperationError, type GenericOperations } from "../api/genericOperations.js";
import type { AuthOperations, SessionUser } from "../api/authOperations.js";
import type { SetupOperations } from "../api/setupOperations.js";
import { createFakeOperations } from "../test/fakeOperations.js";
import { App } from "../App.js";

const USER: SessionUser = {
  id: "user-1",
  email: "operator@example.com",
  locale: "en",
  createdAt: "2026-09-01T12:00:00.000Z",
};

const CONTENT_MARKER = "routed content marker";

/** Generic operations whose view load fails with a recognizable message, so the routed content's presence is observable. */
function contentOperations(): GenericOperations & { getView: ReturnType<typeof vi.fn> } {
  const getView = vi.fn(async () => {
    throw new OperationError("unavailable", CONTENT_MARKER);
  });
  return { ...createFakeOperations({ items: [], relations: [], views: [] }), getView };
}

function stubAuth(overrides: Partial<AuthOperations> = {}): AuthOperations {
  return {
    login: vi.fn(async () => USER),
    getSession: vi.fn(async (): Promise<SessionUser | null> => USER),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderApp({
  auth,
  operations = contentOperations(),
  sessionEvents = new EventTarget(),
  setup,
  login,
}: {
  auth: AuthOperations;
  operations?: GenericOperations;
  sessionEvents?: EventTarget;
  setup?: { token: string; operations: SetupOperations };
  login?: true;
}) {
  render(
    <App
      viewId="view-1"
      operations={operations}
      auth={auth}
      sessionEvents={sessionEvents}
      setup={setup}
      login={login}
      languages={["en"]}
    />,
  );
  return { operations, sessionEvents };
}

describe("App session lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the login page and no content when there is no session", async () => {
    const operations = contentOperations();
    renderApp({ auth: stubAuth({ getSession: vi.fn(async () => null) }), operations });

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText(CONTENT_MARKER)).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(operations.getView).not.toHaveBeenCalled();
  });

  it("renders the header and the routed content for an authenticated session", async () => {
    renderApp({ auth: stubAuth() });

    expect(await screen.findByText("Signed in as operator@example.com")).toBeInTheDocument();
    expect(await screen.findByText(CONTENT_MARKER)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows the content after a successful login from the login page", async () => {
    renderApp({ auth: stubAuth({ getSession: vi.fn(async () => null) }) });

    await userEvent.type(await screen.findByLabelText("Email"), "operator@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Signed in as operator@example.com")).toBeInTheDocument();
    expect(await screen.findByText(CONTENT_MARKER)).toBeInTheDocument();
  });

  it("switches to the login page when an unauthorized event fires mid-session", async () => {
    const { sessionEvents } = renderApp({ auth: stubAuth() });
    await screen.findByText(CONTENT_MARKER);

    act(() => {
      sessionEvents.dispatchEvent(new Event("unauthorized"));
    });

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText(CONTENT_MARKER)).not.toBeInTheDocument();
    expect(screen.queryByText("Signed in as operator@example.com")).not.toBeInTheDocument();
  });

  it("logs out once and switches to the login page", async () => {
    const logout = vi.fn(async () => undefined);
    renderApp({ auth: stubAuth({ logout }) });

    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(CONTENT_MARKER)).not.toBeInTheDocument();
  });

  it("keeps the session and shows the failure when logout is rejected", async () => {
    const logout = vi.fn(async () => {
      throw new OperationError("retryable", "Request to /auth/logout failed with 500", 500);
    });
    renderApp({ auth: stubAuth({ logout }) });

    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Signing out failed: Request to /auth/logout failed with 500")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByText("Signed in as operator@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("renders a failed bootstrap as an error with a retry that re-runs it", async () => {
    const getSession = vi
      .fn<AuthOperations["getSession"]>()
      .mockRejectedValueOnce(new OperationError("retryable", "Request to /auth/session failed with 503", 503))
      .mockResolvedValueOnce(USER);
    renderApp({ auth: stubAuth({ getSession }) });

    expect(await screen.findByText("Request to /auth/session failed with 503")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Signed in as operator@example.com")).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("navigates to / when an authenticated user opens the login route", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    renderApp({ auth: stubAuth(), login: true });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("renders the setup wizard without a header and never asks for the session", async () => {
    const getSession = vi.fn(async () => USER);
    renderApp({
      auth: stubAuth({ getSession }),
      setup: { token: "bootstrap-token", operations: { setupAccount: vi.fn(async () => USER) } },
    });

    expect(await screen.findByRole("heading", { name: "Set up your account" })).toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(getSession).not.toHaveBeenCalled();
  });
});
