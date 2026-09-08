import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import type { McpAgentPageOperations, McpToolGrant } from "../../../api/mcpAgentPageOperations.js";
import { ToolsBlock } from "../ToolsBlock.js";

const PROJECT_ID = "project-1";

function makeRow(overrides: Partial<McpToolGrant> = {}): McpToolGrant {
  return {
    mcpToolRegistrationId: "reg-1",
    toolName: "search_docs",
    description: "Search the docs",
    requiresApproval: false,
    riskClass: "low",
    mcpServerItemId: "server-1",
    mcpServerName: "Docs server",
    mcpServerOnline: true,
    granted: false,
    ...overrides,
  };
}

function stubOperations(overrides: Partial<McpAgentPageOperations> = {}): McpAgentPageOperations {
  return {
    listMcpToolGrants: vi.fn(async () => []),
    setMcpToolGrant: vi.fn(async (input) => ({ granted: input.granted })),
    reclassifyMcpTool: vi.fn(async (input) => ({
      riskClass: input.riskClass ?? "low",
      requiresApproval: input.requiresApproval ?? false,
    })),
    ...overrides,
  };
}

function renderBlock(operations: McpAgentPageOperations) {
  return render(
    <I18nProvider locale="en">
      <ToolsBlock projectItemId={PROJECT_ID} operations={operations} />
    </I18nProvider>,
  );
}

describe("ToolsBlock (issue #127)", () => {
  afterEach(() => cleanup());

  it("shows a loading state before the initial load resolves", async () => {
    let resolve!: (rows: McpToolGrant[]) => void;
    const operations = stubOperations({
      listMcpToolGrants: vi.fn(() => new Promise<McpToolGrant[]>((r) => (resolve = r))),
    });

    renderBlock(operations);

    expect(screen.getByRole("status")).toBeInTheDocument();
    resolve([]);
    await screen.findByText("No active MCP tools are registered in the system yet");
  });

  it("shows an empty state when nothing is registered", async () => {
    renderBlock(stubOperations({ listMcpToolGrants: vi.fn(async () => []) }));

    expect(await screen.findByText("No active MCP tools are registered in the system yet")).toBeInTheDocument();
  });

  it("shows an error state and retries on demand", async () => {
    let calls = 0;
    const listMcpToolGrants = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("transport down");
      return [];
    });

    renderBlock(stubOperations({ listMcpToolGrants }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport down");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No active MCP tools are registered in the system yet")).toBeInTheDocument();
  });

  it("groups tools by server, defaults the checkbox unchecked, and flags an offline server", async () => {
    renderBlock(
      stubOperations({
        listMcpToolGrants: vi.fn(async () => [makeRow({ mcpServerOnline: false })]),
      }),
    );

    expect(await screen.findByText("Docs server")).toBeInTheDocument();
    expect(screen.getByText("Server offline")).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: "search_docs" });
    expect(checkbox).not.toBeChecked();
  });

  it("round-trips a checkbox toggle to the exact project/tool pair", async () => {
    const setMcpToolGrant = vi.fn(async (input: { projectItemId: string; mcpToolRegistrationId: string; granted: boolean }) => ({
      granted: input.granted,
    }));
    renderBlock(
      stubOperations({
        listMcpToolGrants: vi.fn(async () => [makeRow()]),
        setMcpToolGrant,
      }),
    );

    const checkbox = await screen.findByRole("checkbox", { name: "search_docs" });
    await userEvent.click(checkbox);

    expect(setMcpToolGrant).toHaveBeenCalledWith({
      projectItemId: PROJECT_ID,
      mcpToolRegistrationId: "reg-1",
      granted: true,
    });
  });

  it("shows a per-row mutation error without discarding the row", async () => {
    const setMcpToolGrant = vi.fn(async () => {
      throw new Error("write failed");
    });
    renderBlock(
      stubOperations({
        listMcpToolGrants: vi.fn(async () => [makeRow()]),
        setMcpToolGrant,
      }),
    );

    const checkbox = await screen.findByRole("checkbox", { name: "search_docs" });
    await userEvent.click(checkbox);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: write failed");
    expect(screen.getByRole("checkbox", { name: "search_docs" })).toBeInTheDocument();
  });

  it("keeps existing rows visible and shows a refreshing indicator during a background reload", async () => {
    let releaseSecondLoad!: () => void;
    let secondLoadCalled = false;
    const listMcpToolGrants = vi.fn(async () => {
      if (!secondLoadCalled) {
        secondLoadCalled = true;
        return [makeRow()];
      }
      await new Promise<void>((resolve) => (releaseSecondLoad = resolve));
      return [makeRow({ granted: true })];
    });
    const setMcpToolGrant = vi.fn(async (input: { granted: boolean }) => ({ granted: input.granted }));

    renderBlock(stubOperations({ listMcpToolGrants, setMcpToolGrant }));

    const checkbox = await screen.findByRole("checkbox", { name: "search_docs" });
    await userEvent.click(checkbox);

    expect(await screen.findByText("Refreshing…")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "search_docs" })).toBeInTheDocument();

    releaseSecondLoad();
    await screen.findByText((_, element) => element?.tagName === "H3" && element.textContent === "Docs server");
  });
});
