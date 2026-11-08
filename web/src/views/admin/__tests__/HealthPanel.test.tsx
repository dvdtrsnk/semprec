import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AdminOperations, OperationsHealth } from "../../../api/adminOperations.js";
import { HealthPanel } from "../HealthPanel.js";

const GENERATED_AT = "2026-10-18T00:00:00.000Z";

function makeReport(overrides: Partial<OperationsHealth> = {}): OperationsHealth {
  return {
    generatedAt: GENERATED_AT,
    processes: [
      {
        process: "api",
        present: true,
        stale: false,
        pid: 10,
        version: "1.4.0",
        startedAt: null,
        beatAt: null,
        uptimeMs: null,
      },
      {
        process: "agents",
        present: true,
        stale: true,
        pid: 11,
        version: "1.4.0",
        startedAt: null,
        beatAt: null,
        uptimeMs: null,
      },
      {
        process: "transcribe",
        present: false,
        stale: false,
        pid: null,
        version: null,
        startedAt: null,
        beatAt: null,
        uptimeMs: null,
      },
      {
        process: "ai-gateway",
        present: true,
        stale: false,
        pid: 12,
        version: "1.3.9",
        startedAt: null,
        beatAt: null,
        uptimeMs: null,
      },
    ],
    alertingChecks: [],
    queue: { pending: 7, overdue: 0, permanent: 0 },
    tenants: { provisioning: 1, active: 4, suspended: 2, deleting: 0 },
    tenantAggregates: { agentRunErrors7d: 3, itemAutomationErrors: 5, alertingTenantChecks: 0 },
    ...overrides,
  };
}

function stubOperations(getOperationsHealth: AdminOperations["getOperationsHealth"]): AdminOperations {
  return {
    listAccounts: vi.fn(async () => []),
    suspendAccount: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    reactivateAccount: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    deleteAccount: vi.fn(async () => {
      throw new Error("unused");
    }),
    changeRole: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    listInvites: vi.fn(async () => []),
    createInvite: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    revokeInvite: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    listAiBudgets: vi.fn(async () => []),
    setAiBudget: vi.fn(async () => undefined),
    getOperationsHealth,
  };
}

function renderPanel(operations: AdminOperations) {
  return render(
    <I18nProvider locale="en">
      <HealthPanel operations={operations} />
    </I18nProvider>,
  );
}

describe("HealthPanel (issue #1082)", () => {
  afterEach(() => cleanup());

  it("shows the healthy summary when no operator check is alerting", async () => {
    renderPanel(stubOperations(async () => makeReport()));

    expect(await screen.findByText("All operator checks are healthy")).toBeInTheDocument();
    expect(screen.getByText("No checks are alerting")).toBeInTheDocument();
  });

  it("shows the degraded summary with the alerting-check count and names each check", async () => {
    renderPanel(
      stubOperations(async () =>
        makeReport({
          alertingChecks: [
            { checkKey: "queue_backlog", detail: {}, changedAt: GENERATED_AT },
            { checkKey: "process:agents", detail: {}, changedAt: GENERATED_AT },
          ],
        }),
      ),
    );

    expect(await screen.findByText("2 operator check(s) alerting")).toBeInTheDocument();
    expect(screen.getByText("queue_backlog")).toBeInTheDocument();
    expect(screen.getByText("process:agents")).toBeInTheDocument();
  });

  it("does not render the detail of an alerting check", async () => {
    const secret = "user-private-subject-line";
    renderPanel(
      stubOperations(async () =>
        makeReport({
          alertingChecks: [{ checkKey: "process:agents", detail: { message: secret }, changedAt: GENERATED_AT }],
        }),
      ),
    );

    await screen.findByText("process:agents");
    expect(document.body.textContent).not.toContain(secret);
  });

  it("shows each fixed process with its running, stale or not-reporting state and version", async () => {
    renderPanel(stubOperations(async () => makeReport()));

    const api = (await screen.findByText("api")).closest("li");
    expect(api).toHaveTextContent("Running");
    expect(api).toHaveTextContent("Version 1.4.0");

    const agents = screen.getByText("agents").closest("li");
    expect(agents).toHaveTextContent("Stale");
    expect(agents?.className).toContain("system-status__row--degraded");

    const transcribe = screen.getByText("transcribe").closest("li");
    expect(transcribe).toHaveTextContent("Not reporting");
  });

  it("marks overdue and permanent queue jobs degraded when non-zero and never marks pending", async () => {
    renderPanel(stubOperations(async () => makeReport({ queue: { pending: 7, overdue: 2, permanent: 1 } })));

    const pending = (await screen.findByText("Pending: 7")).closest("li");
    const overdue = screen.getByText("Overdue: 2").closest("li");
    const permanent = screen.getByText("Permanently failed: 1").closest("li");
    expect(pending?.className).toBe("system-status__row");
    expect(overdue?.className).toContain("system-status__row--degraded");
    expect(permanent?.className).toContain("system-status__row--degraded");
  });

  it("does not mark zero overdue or permanent jobs degraded", async () => {
    renderPanel(stubOperations(async () => makeReport()));

    const overdue = (await screen.findByText("Overdue: 0")).closest("li");
    const permanent = screen.getByText("Permanently failed: 0").closest("li");
    expect(overdue?.className).toBe("system-status__row");
    expect(permanent?.className).toBe("system-status__row");
  });

  it("shows the four account-status counts and the three cross-tenant aggregates", async () => {
    renderPanel(stubOperations(async () => makeReport()));

    expect(await screen.findByText("Provisioning: 1")).toBeInTheDocument();
    expect(screen.getByText("Active: 4")).toBeInTheDocument();
    expect(screen.getByText("Suspended: 2")).toBeInTheDocument();
    expect(screen.getByText("Deleting: 0")).toBeInTheDocument();
    expect(screen.getByText("Agent run errors (7 days): 3")).toBeInTheDocument();
    expect(screen.getByText("Item automation errors: 5")).toBeInTheDocument();
    expect(screen.getByText("Account checks alerting: 0")).toBeInTheDocument();
  });

  it("shows the error state and reloads the report when retry is chosen", async () => {
    const getOperationsHealth = vi
      .fn<AdminOperations["getOperationsHealth"]>()
      .mockRejectedValueOnce(new OperationError("retryable", "boom"))
      .mockResolvedValueOnce(makeReport());
    renderPanel(stubOperations(getOperationsHealth));

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("All operator checks are healthy")).toBeInTheDocument();
    expect(getOperationsHealth).toHaveBeenCalledTimes(2);
  });
});
