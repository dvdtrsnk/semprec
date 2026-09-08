import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import type { AgentRun, AgentRunOperations } from "../../../api/agentRunOperations.js";
import { AgentRunDetail } from "../AgentRunDetail.js";

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    projectItemId: "project-1",
    parentRunId: null,
    heartbeatId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "search the docs",
    status: "running",
    result: null,
    startedAt: "2026-09-01T12:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function stubOperations(overrides: Partial<AgentRunOperations> = {}): AgentRunOperations {
  return {
    getAgentRun: vi.fn(async () => makeRun()),
    ...overrides,
  };
}

function renderDetail(operations: AgentRunOperations, agentRunId = "run-1") {
  return render(
    <I18nProvider locale="en">
      <AgentRunDetail agentRunId={agentRunId} operations={operations} />
    </I18nProvider>,
  );
}

describe("AgentRunDetail (issue #132)", () => {
  afterEach(() => cleanup());

  it("shows a loading state before the initial load resolves", async () => {
    let resolve!: (run: AgentRun | null) => void;
    const operations = stubOperations({
      getAgentRun: vi.fn(() => new Promise<AgentRun | null>((r) => (resolve = r))),
    });

    renderDetail(operations);

    expect(screen.getByRole("status")).toBeInTheDocument();
    resolve(makeRun());
    await screen.findByText("search the docs");
  });

  it("shows a not-found state for an unknown run id", async () => {
    renderDetail(stubOperations({ getAgentRun: vi.fn(async () => null) }));

    expect(await screen.findByText("This agent run could not be found")).toBeInTheDocument();
  });

  it("shows an error state and retries on demand", async () => {
    let calls = 0;
    const getAgentRun = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("transport down");
      return makeRun();
    });

    renderDetail(stubOperations({ getAgentRun }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport down");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("search the docs")).toBeInTheDocument();
  });

  it("renders the run's task, status, triggeredBy, and result", async () => {
    renderDetail(
      stubOperations({
        getAgentRun: vi.fn(async () =>
          makeRun({ status: "done", result: "found 3 matches", triggeredBy: "heartbeat" }),
        ),
      }),
    );

    expect(await screen.findByText("search the docs")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Heartbeat")).toBeInTheDocument();
    expect(screen.getByText("found 3 matches")).toBeInTheDocument();
  });
});
