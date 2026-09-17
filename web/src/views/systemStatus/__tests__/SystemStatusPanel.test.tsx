import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import type { SystemHealthOperations, SystemHealthReport } from "../../../api/systemHealthOperations.js";
import { SystemStatusPanel } from "../SystemStatusPanel.js";

function makeReport(overrides: Partial<SystemHealthReport> = {}): SystemHealthReport {
  return {
    generatedAt: "2026-09-17T00:00:00.000Z",
    processes: [
      {
        process: "api",
        present: true,
        stale: false,
        pid: 1,
        version: "1.2.3",
        startedAt: "2026-09-16T00:00:00.000Z",
        beatAt: "2026-09-17T00:00:00.000Z",
        uptimeMs: 86_400_000,
      },
    ],
    alertingChecks: [],
    queue: { pending: 0, overdue: 0, permanent: 0 },
    itemAutomationErrorsByDatabase: [],
    agentRunErrors7d: 0,
    mailboxes: [],
    ...overrides,
  };
}

function stubOperations(
  getSystemHealthReport: SystemHealthOperations["getSystemHealthReport"],
): SystemHealthOperations {
  return { getSystemHealthReport };
}

function renderPanel(operations: SystemHealthOperations) {
  return render(
    <I18nProvider locale="en">
      <SystemStatusPanel operations={operations} />
    </I18nProvider>,
  );
}

describe("SystemStatusPanel (issue #170)", () => {
  afterEach(() => cleanup());

  it("shows a loading state before the report resolves", () => {
    renderPanel(stubOperations(() => new Promise(() => {})));

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows a healthy summary when there are no alerting checks", async () => {
    renderPanel(stubOperations(async () => makeReport()));

    expect(await screen.findByText("All monitored components are healthy")).toBeInTheDocument();
  });

  it("shows a degraded summary and names each alerting component", async () => {
    renderPanel(
      stubOperations(async () =>
        makeReport({
          alertingChecks: [{ checkKey: "process:agents", detail: {}, changedAt: "2026-09-17T00:00:00.000Z" }],
        }),
      ),
    );

    expect(await screen.findByText("1 component(s) degraded")).toBeInTheDocument();
    expect(screen.getByText("process:agents")).toBeInTheDocument();
  });

  it("shows an empty state when nothing is being monitored", async () => {
    renderPanel(stubOperations(async () => makeReport({ processes: [], mailboxes: [] })));

    expect(await screen.findByText("No system status data is available")).toBeInTheDocument();
  });

  it("shows an error state and retries on demand", async () => {
    let calls = 0;
    renderPanel(
      stubOperations(async () => {
        calls++;
        if (calls === 1) throw new Error("network blip");
        return makeReport();
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("network blip");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("All monitored components are healthy")).toBeInTheDocument();
  });

  it("renders queue, item automation, agent run, and mailbox sections with no secrets", async () => {
    renderPanel(
      stubOperations(async () =>
        makeReport({
          queue: { pending: 3, overdue: 1, permanent: 1 },
          itemAutomationErrorsByDatabase: [{ databaseId: "db-1", errorCount: 2 }],
          agentRunErrors7d: 4,
          mailboxes: [
            {
              mailboxItemId: "mbx-1",
              lastActivityAt: null,
              lastError: "connection refused",
              nextExpectedActivityAt: null,
            },
          ],
        }),
      ),
    );

    expect(await screen.findByText("Pending: 3")).toBeInTheDocument();
    expect(screen.getByText("Overdue: 1")).toBeInTheDocument();
    expect(screen.getByText("Permanently failed: 1")).toBeInTheDocument();
    expect(screen.getByText("db-1: 2")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("mbx-1")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("connection refused")).not.toBeInTheDocument();
  });
});
