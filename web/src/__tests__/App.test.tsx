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

const CONTENT_MARKER_STATUS = 599;
const CONTENT_MARKER = `The server answered with status ${CONTENT_MARKER_STATUS}`;

/** Generic operations whose view load fails with a recognizable status, so the routed content's presence is observable. */
function contentOperations(): GenericOperations & { getView: ReturnType<typeof vi.fn> } {
  const getView = vi.fn(async () => {
    throw new OperationError("unavailable", "routed content marker", CONTENT_MARKER_STATUS);
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
  languages = ["en"],
}: {
  auth: AuthOperations;
  operations?: GenericOperations;
  sessionEvents?: EventTarget;
  setup?: { token: string; operations: SetupOperations };
  login?: true;
  languages?: readonly string[];
}) {
  render(
    <App
      viewId="view-1"
      operations={operations}
      auth={auth}
      sessionEvents={sessionEvents}
      setup={setup}
      login={login}
      languages={languages}
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

  it("reloads to a clean URL when an unauthorized event fires mid-session", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    const { sessionEvents } = renderApp({ auth: stubAuth() });
    await screen.findByText(CONTENT_MARKER);

    act(() => {
      sessionEvents.dispatchEvent(new Event("unauthorized"));
    });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText(CONTENT_MARKER)).not.toBeInTheDocument();
    expect(screen.queryByText("Signed in as operator@example.com")).not.toBeInTheDocument();
  });

  it("does not navigate when an unauthorized event fires on the login page", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    const { sessionEvents } = renderApp({ auth: stubAuth({ getSession: vi.fn(async () => null) }) });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();

    act(() => {
      sessionEvents.dispatchEvent(new Event("unauthorized"));
    });

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("logs out once and reloads to a clean URL", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    const logout = vi.fn(async () => undefined);
    renderApp({ auth: stubAuth({ logout }) });

    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(CONTENT_MARKER)).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("keeps the session and shows the failure when logout is rejected", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
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
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders a failed bootstrap as an error with a retry that re-runs it", async () => {
    const getSession = vi
      .fn<AuthOperations["getSession"]>()
      .mockRejectedValueOnce(new OperationError("retryable", "Request to /auth/session failed with 503", 503))
      .mockResolvedValueOnce(USER);
    renderApp({ auth: stubAuth({ getSession }) });

    expect(await screen.findByText("The server answered with status 503")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Signed in as operator@example.com")).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("follows the browser language for the login page, before a session is known", async () => {
    renderApp({ auth: stubAuth({ getSession: vi.fn(async () => null) }), languages: ["cs"] });

    expect(await screen.findByRole("heading", { name: "Přihlášení" })).toBeInTheDocument();
  });

  it("follows the session user's locale once authenticated, even when it differs from the browser's", async () => {
    renderApp({ auth: stubAuth({ getSession: vi.fn(async () => ({ ...USER, locale: "en" })) }), languages: ["cs"] });

    expect(await screen.findByText("Signed in as operator@example.com")).toBeInTheDocument();
  });

  it("navigates to / when an authenticated user opens the login route", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    renderApp({ auth: stubAuth(), login: true });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("renders the setup wizard without a header and never asks for the session", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    const getSession = vi.fn(async () => USER);
    const { sessionEvents } = renderApp({
      auth: stubAuth({ getSession }),
      setup: { token: "bootstrap-token", operations: { setupAccount: vi.fn(async () => USER) } },
    });

    expect(await screen.findByRole("heading", { name: "Set up your account" })).toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    act(() => {
      sessionEvents.dispatchEvent(new Event("unauthorized"));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
