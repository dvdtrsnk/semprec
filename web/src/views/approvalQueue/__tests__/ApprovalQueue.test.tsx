import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import type {
  ApprovalQueueEntry,
  ApprovalQueueOperations,
  ApprovalRequestRow,
  DecidedApprovalRequest,
} from "../../../api/approvalQueueOperations.js";
import { ApprovalQueue } from "../ApprovalQueue.js";

const DECIDED_BY = "user-1";

function makeRow(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    id: "req-1",
    toolName: "send_email",
    riskClass: "high",
    requestedAt: "2026-09-01T12:00:00.000Z",
    safeSummary: {
      mcpToolRegistrationId: "reg-1",
      mcpServerItemId: "server-1",
      argKeys: ["to", "subject"],
    },
    agentRunId: "run-1",
    projectItemId: "project-1",
    projectName: "Acme project",
    ...overrides,
  };
}

function okEntry(overrides: Partial<ApprovalRequestRow> = {}): ApprovalQueueEntry {
  return { kind: "ok", row: makeRow(overrides) };
}

function stubOperations(overrides: Partial<ApprovalQueueOperations> = {}): ApprovalQueueOperations {
  return {
    listApprovalRequests: vi.fn(async () => []),
    decideApprovalRequest: vi.fn(async (input) => ({
      id: input.approvalRequestId,
      status: input.decision,
      decidedAt: "2026-09-01T12:05:00.000Z",
      decidedBy: input.decidedByUserId,
    })),
    ...overrides,
  };
}

function renderQueue(operations: ApprovalQueueOperations) {
  return render(
    <I18nProvider locale="en">
      <ApprovalQueue operations={operations} decidedByUserId={DECIDED_BY} />
    </I18nProvider>,
  );
}

describe("ApprovalQueue (issue #132)", () => {
  afterEach(() => cleanup());

  it("shows a loading state before the initial load resolves", async () => {
    let resolve!: (rows: ApprovalQueueEntry[]) => void;
    const operations = stubOperations({
      listApprovalRequests: vi.fn(() => new Promise<ApprovalQueueEntry[]>((r) => (resolve = r))),
    });

    renderQueue(operations);

    expect(screen.getByRole("status")).toBeInTheDocument();
    resolve([]);
    await screen.findByText("No pending approval requests");
  });

  it("shows an empty state when nothing is pending", async () => {
    renderQueue(stubOperations({ listApprovalRequests: vi.fn(async () => []) }));

    expect(await screen.findByText("No pending approval requests")).toBeInTheDocument();
  });

  it("shows an error state and retries on demand", async () => {
    let calls = 0;
    const listApprovalRequests = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("transport down");
      return [];
    });

    renderQueue(stubOperations({ listApprovalRequests }));

    expect(await screen.findByRole("alert")).toHaveTextContent("transport down");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No pending approval requests")).toBeInTheDocument();
  });

  it("renders a pending row's tool, risk class, args, project, and agent run", async () => {
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async () => [okEntry()]),
      }),
    );

    expect(await screen.findByText("send_email")).toBeInTheDocument();
    expect(screen.getByText("Risk class: high")).toBeInTheDocument();
    expect(screen.getByText("Arguments: to, subject")).toBeInTheDocument();
    expect(screen.getByText("Acme project", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Agent run run-1", { exact: false })).toBeInTheDocument();
  });

  it("requests from different projects appear together", async () => {
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async () => [
          okEntry({ id: "req-1", toolName: "send_email", projectName: "Acme" }),
          okEntry({ id: "req-2", toolName: "delete_file", projectName: "Other" }),
        ]),
      }),
    );

    expect(await screen.findByText("send_email")).toBeInTheDocument();
    expect(screen.getByText("delete_file")).toBeInTheDocument();
  });

  it("approves a request and shows the decided state", async () => {
    const decideApprovalRequest = vi.fn(
      async (): Promise<DecidedApprovalRequest> => ({
        id: "req-1",
        status: "approved",
        decidedAt: "2026-09-01T12:05:00.000Z",
        decidedBy: DECIDED_BY,
      }),
    );
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async () => [okEntry()]),
        decideApprovalRequest,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(decideApprovalRequest).toHaveBeenCalledWith({
      approvalRequestId: "req-1",
      decision: "approved",
      decidedByUserId: DECIDED_BY,
    });
    expect(await screen.findByText("Approved by user-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("rejects a request and shows the decided state", async () => {
    const decideApprovalRequest = vi.fn(
      async (): Promise<DecidedApprovalRequest> => ({
        id: "req-1",
        status: "rejected",
        decidedAt: "2026-09-01T12:05:00.000Z",
        decidedBy: DECIDED_BY,
      }),
    );
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async () => [okEntry()]),
        decideApprovalRequest,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));

    expect(await screen.findByText("Rejected by user-1")).toBeInTheDocument();
  });

  it("shows a race note when the authoritative decision differs from what was requested", async () => {
    const decideApprovalRequest = vi.fn(
      async (): Promise<DecidedApprovalRequest> => ({
        id: "req-1",
        status: "rejected",
        decidedAt: "2026-09-01T12:05:00.000Z",
        decidedBy: "someone-else",
      }),
    );
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async () => [okEntry()]),
        decideApprovalRequest,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Rejected by someone-else")).toBeInTheDocument();
    expect(screen.getByText("This request was already decided before your action went through")).toBeInTheDocument();
  });

  it("shows a per-row action error without discarding the row", async () => {
    const decideApprovalRequest = vi.fn(async () => {
      throw new Error("write failed");
    });
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async () => [okEntry()]),
        decideApprovalRequest,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: write failed");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("renders a malformed row as a placeholder without affecting the rest of the list", async () => {
    renderQueue(
      stubOperations({
        listApprovalRequests: vi.fn(async (): Promise<ApprovalQueueEntry[]> => [
          { kind: "malformed", row: { id: "bad-1", raw: { id: "bad-1", toolName: 42 } } },
          okEntry({ id: "req-2", toolName: "delete_file" }),
        ]),
      }),
    );

    expect(await screen.findByText("This request could not be displayed (malformed data)", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("delete_file")).toBeInTheDocument();
  });
});
