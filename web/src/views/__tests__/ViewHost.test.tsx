import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../i18n/index.js";
import { OperationError, type GenericOperations, type View } from "../../api/genericOperations.js";
import { createFakeOperations } from "../../test/fakeOperations.js";
import { VIEW_ID, createMailboxBackend, mailboxView } from "../../test/mailboxFixture.js";
import { setViewport } from "../../test/renderMailbox.js";
import { createDefaultViewRegistry } from "../registerViews.js";
import { ViewHost } from "../ViewHost.js";
import { createViewRegistry, registerViewRenderer, resolveViewRenderer } from "../viewRegistry.js";

function renderHost(operations: GenericOperations, viewId = VIEW_ID) {
  return render(
    <I18nProvider locale="en">
      <ViewHost viewId={viewId} operations={operations} registry={createDefaultViewRegistry()} />
    </I18nProvider>,
  );
}

describe("view resolution", () => {
  beforeEach(() => setViewport(false));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("resolves the mailbox view through the registered client component", async () => {
    renderHost(createFakeOperations(createMailboxBackend()));

    expect(await screen.findByRole("region", { name: "Folders" })).toBeInTheDocument();
  });

  it("resolves by view type when the payload carries no clientComponent", () => {
    const registry = createDefaultViewRegistry();
    const withoutComponent: View = { ...mailboxView, clientComponent: undefined };
    expect(resolveViewRenderer(registry, withoutComponent)).toBeDefined();
  });

  it("prefers the clientComponent over the view type when both are registered", () => {
    const registry = createViewRegistry();
    const byComponent = () => null;
    const byType = () => null;
    registerViewRenderer(registry, "mailboxClient", byComponent);
    registerViewRenderer(registry, "mailbox-client", byType);
    expect(resolveViewRenderer(registry, mailboxView)).toBe(byComponent);
  });

  it("shows an unavailable state for a view type this client has no renderer for", async () => {
    const backend = createMailboxBackend();
    backend.views = [{ ...mailboxView, type: "kanban", clientComponent: "kanbanBoard" }];
    renderHost(createFakeOperations(backend));

    expect(await screen.findByText("Not available")).toBeInTheDocument();
  });

  it("surfaces an unavailable view load as an unavailable state", async () => {
    const inner = createFakeOperations(createMailboxBackend());
    const operations: GenericOperations = {
      ...inner,
      getView: async () => {
        throw new OperationError("unavailable", "Request to /views/view-mailbox failed with 404", 404);
      },
    };
    renderHost(operations);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not available");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
