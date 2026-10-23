import type { ComponentProps, ReactNode } from "react";
import type { Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../App.js";

const { app, roots } = vi.hoisted(() => {
  const roots: Root[] = [];
  return { app: vi.fn<(_props: ComponentProps<typeof App>) => ReactNode>(() => null), roots };
});

vi.mock("../App.js", () => ({ App: app }));
vi.mock("react-dom/client", async (importOriginal) => {
  const client = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...client,
    createRoot: (...args: Parameters<typeof client.createRoot>) => {
      const root = client.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

describe("password-reset composition-root routing", () => {
  const originalUrl = window.location.href;
  const originalHistoryState: unknown = window.history.state;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    app.mockClear();
    container = document.createElement("div");
    container.id = "root";
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    container.remove();
    window.history.replaceState(originalHistoryState, "", originalUrl);
  });

  it.each([
    { hash: "#token=abc", token: "abc" },
    { hash: "#token=", token: null },
    { hash: "", token: null },
    { hash: "#other=abc", token: null },
  ])("passes token=$token for a password-reset route with hash '$hash'", async ({ hash, token }) => {
    window.history.replaceState(null, "", `/?page=password-reset${hash}`);

    await act(async () => {
      await import("../main.js");
    });

    expect(app).toHaveBeenCalledWith(expect.objectContaining({ passwordReset: { token } }), undefined);
  });

  it("does not create a password-reset route for another page, even with a token fragment", async () => {
    window.history.replaceState(null, "", "/?page=login#token=abc");

    await act(async () => {
      await import("../main.js");
    });

    expect(app).toHaveBeenCalledWith(expect.objectContaining({ passwordReset: undefined, login: true }), undefined);
  });
});
