import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../../i18n/index.js";
import type { GenericOperations, Item } from "../../../api/genericOperations.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { McpAgentPageOperations } from "../../../api/mcpAgentPageOperations.js";
import { AgentPage } from "../AgentPage.js";

const DATABASE_ID = "db-projects";
const PROJECT_ID = "project-1";

function makeItem(overrides: Partial<Item["properties"]> = {}): Item {
  return {
    id: PROJECT_ID,
    databaseId: DATABASE_ID,
    properties: { name: "Demo project", ...overrides },
    computed: {},
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function stubGenericOperations(getItem: GenericOperations["getItem"]): GenericOperations {
  return { getItem } as unknown as GenericOperations;
}

function stubMcpOperations(): McpAgentPageOperations {
  return {
    listMcpToolGrants: vi.fn(async () => []),
    setMcpToolGrant: vi.fn(async (input) => ({ granted: input.granted })),
    reclassifyMcpTool: vi.fn(async (input) => ({
      riskClass: input.riskClass ?? "low",
      requiresApproval: input.requiresApproval ?? false,
    })),
  };
}

function renderPage(getItem: GenericOperations["getItem"], mcpOperations: McpAgentPageOperations = stubMcpOperations()) {
  return render(
    <I18nProvider locale="en">
      <AgentPage
        projectItemId={PROJECT_ID}
        databaseId={DATABASE_ID}
        genericOperations={stubGenericOperations(getItem)}
        mcpOperations={mcpOperations}
      />
    </I18nProvider>,
  );
}

describe("AgentPage (issue #127)", () => {
  afterEach(() => cleanup());

  it("shows a loading state before the project item resolves", async () => {
    let resolve!: (item: Item) => void;
    renderPage(() => new Promise((r) => (resolve = r)));

    expect(screen.getByRole("status")).toBeInTheDocument();
    resolve(makeItem());
    await screen.findByText("Demo project");
  });

  it("shows an error state and retries on demand", async () => {
    let calls = 0;
    const getItem = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new OperationError("retryable", "transport down");
      return makeItem();
    });

    renderPage(getItem);

    expect(await screen.findByRole("alert")).toHaveTextContent("transport down");
    expect(getItem).toHaveBeenCalledWith(DATABASE_ID, PROJECT_ID);
  });

  it("shows a not-found state when the project item does not exist", async () => {
    renderPage(async () => null);

    expect(await screen.findByText("This project could not be found")).toBeInTheDocument();
  });

  it("renders the agents guidance text below the project name", async () => {
    renderPage(async () => makeItem({ agents: "Purpose: do the thing.\nAllowed: read data." }));

    await screen.findByText("Demo project");
    expect(screen.getByText((_, element) => element?.textContent === "Purpose: do the thing.\nAllowed: read data.")).toBeInTheDocument();
  });

  it("shows an empty guidance state when the project has no agents text yet", async () => {
    renderPage(async () => makeItem());

    expect(await screen.findByText("No guidance has been set for this project yet")).toBeInTheDocument();
  });

  it("renders a heartbeats placeholder", async () => {
    renderPage(async () => makeItem());

    expect(await screen.findByText("Heartbeats are not yet available on this page")).toBeInTheDocument();
  });

  it("renders the Tools block below guidance and heartbeats", async () => {
    const mcpOperations = stubMcpOperations();
    renderPage(async () => makeItem(), mcpOperations);

    await screen.findByText("Demo project");
    expect(await screen.findByText("No active MCP tools are registered in the system yet")).toBeInTheDocument();
    expect(mcpOperations.listMcpToolGrants).toHaveBeenCalledWith(PROJECT_ID);
  });
});
