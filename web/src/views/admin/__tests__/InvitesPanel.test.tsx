import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../../i18n/index.js";
import { OperationError } from "../../../api/genericOperations.js";
import type { AdminOperations, CreatedInvite, InviteSummary } from "../../../api/adminOperations.js";
import { InvitesPanel } from "../InvitesPanel.js";

const URL_ONE = "https://example.com/?page=invite#token=one";
const URL_TWO = "https://example.com/?page=invite#token=two";

function invite(overrides: Partial<InviteSummary> = {}): InviteSummary {
  return {
    id: "i1",
    email: "pending@example.com",
    invitedBy: "user-1",
    createdAt: "2026-10-01T09:00:00.000Z",
    expiresAt: "2026-10-08T09:00:00.000Z",
    acceptedAt: null,
    revokedAt: null,
    status: "pending",
    ...overrides,
  };
}

function created(overrides: Partial<CreatedInvite> = {}): CreatedInvite {
  return { invite: invite({ id: "i-new" }), inviteUrl: URL_ONE, emailed: true, ...overrides };
}

function stubOperations(overrides: Partial<AdminOperations> = {}): AdminOperations {
  return {
    listAccounts: vi.fn(async () => []),
    suspendAccount: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    reactivateAccount: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    changeRole: vi.fn(async () => {
      throw new OperationError("retryable", "unused");
    }),
    listInvites: vi.fn(async (): Promise<InviteSummary[]> => [invite()]),
    createInvite: vi.fn(async () => created()),
    revokeInvite: vi.fn(async () => invite({ status: "revoked", revokedAt: "2026-10-02T09:00:00.000Z" })),
    ...overrides,
  };
}

function renderPanel(operations: AdminOperations) {
  return render(
    <I18nProvider locale="en">
      <InvitesPanel operations={operations} />
    </I18nProvider>,
  );
}

async function submitEmail(address: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), address);
  await user.click(screen.getByRole("button", { name: "Create invitation" }));
}

describe("InvitesPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("creates an invitation, shows its link read-only with the emailed message, clears the field and reloads", async () => {
    const operations = stubOperations();
    renderPanel(operations);
    await screen.findByRole("row", { name: /pending@example.com/ });

    await submitEmail("new@example.com");

    expect(operations.createInvite).toHaveBeenCalledWith("new@example.com");
    const link = await screen.findByLabelText("Invitation link");
    expect(link).toHaveValue(URL_ONE);
    expect(link).toHaveAttribute("readonly");
    expect(screen.getByText("The invitation was emailed to the invitee.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("");
    await vi.waitFor(() => expect(operations.listInvites).toHaveBeenCalledTimes(2));
  });

  it("shows the not-emailed message when the server did not send the mail", async () => {
    const operations = stubOperations({ createInvite: vi.fn(async () => created({ emailed: false })) });
    renderPanel(operations);
    await screen.findByRole("row", { name: /pending@example.com/ });

    await submitEmail("new@example.com");

    expect(
      await screen.findByText("The invitation was not emailed. Copy the link and pass it on yourself."),
    ).toBeInTheDocument();
    expect(screen.queryByText("The invitation was emailed to the invitee.")).not.toBeInTheDocument();
  });

  it("replaces the shown link with the one from a second creation", async () => {
    const createInvite = vi
      .fn<AdminOperations["createInvite"]>()
      .mockResolvedValueOnce(created({ inviteUrl: URL_ONE }))
      .mockResolvedValueOnce(created({ inviteUrl: URL_TWO }));
    renderPanel(stubOperations({ createInvite }));
    await screen.findByRole("row", { name: /pending@example.com/ });

    await submitEmail("first@example.com");
    expect(await screen.findByDisplayValue(URL_ONE)).toBeInTheDocument();

    await submitEmail("second@example.com");
    expect(await screen.findByDisplayValue(URL_TWO)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(URL_ONE)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Invitation link")).toHaveLength(1);
  });

  it("after a remount shows no link and writes nothing to local or session storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const operations = stubOperations();
    const first = renderPanel(operations);
    await screen.findByRole("row", { name: /pending@example.com/ });
    await submitEmail("new@example.com");
    await screen.findByDisplayValue(URL_ONE);

    first.unmount();
    renderPanel(operations);
    await screen.findByRole("row", { name: /pending@example.com/ });

    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(URL_ONE)).not.toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("shows each row's server status label, and offers Revoke for pending rows only", async () => {
    const operations = stubOperations({
      listInvites: vi.fn(async () => [
        invite({ id: "p", email: "pending@example.com", status: "pending" }),
        invite({ id: "a", email: "accepted@example.com", status: "accepted", acceptedAt: "2026-10-02T09:00:00.000Z" }),
        invite({ id: "r", email: "revoked@example.com", status: "revoked", revokedAt: "2026-10-02T09:00:00.000Z" }),
        invite({ id: "x", email: "expired@example.com", status: "expired" }),
      ]),
    });
    renderPanel(operations);

    expect(await screen.findByRole("row", { name: /pending@example.com/ })).toHaveTextContent("Pending");
    expect(screen.getByRole("row", { name: /accepted@example.com/ })).toHaveTextContent("Accepted");
    expect(screen.getByRole("row", { name: /revoked@example.com/ })).toHaveTextContent("Revoked");
    expect(screen.getByRole("row", { name: /expired@example.com/ })).toHaveTextContent("Expired");

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    expect(revokeButtons).toHaveLength(1);
    expect(
      within(screen.getByRole("row", { name: /pending@example.com/ })).getByRole("button", { name: "Revoke" }),
    ).toBeInTheDocument();
  });

  it("a successful revoke calls the server for that invite and reloads the list", async () => {
    const operations = stubOperations();
    renderPanel(operations);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    expect(operations.revokeInvite).toHaveBeenCalledWith("i1");
    await vi.waitFor(() => expect(operations.listInvites).toHaveBeenCalledTimes(2));
  });

  it("a rejected create shows its message in an alert and keeps the typed email", async () => {
    const operations = stubOperations({
      createInvite: vi.fn(async () => {
        throw new OperationError("retryable", "validation_failed", 400);
      }),
    });
    renderPanel(operations);
    await screen.findByRole("row", { name: /pending@example.com/ });

    await submitEmail("taken@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent("The action failed: validation_failed");
    expect(screen.getByLabelText("Email")).toHaveValue("taken@example.com");
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument();
  });

  it("a rejected revoke shows its message in an alert and keeps the list", async () => {
    const operations = stubOperations({
      revokeInvite: vi.fn(async () => {
        throw new OperationError("retryable", "invite_not_pending", 409);
      }),
    });
    renderPanel(operations);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The action failed: invite_not_pending");
    expect(screen.getByRole("row", { name: /pending@example.com/ })).toBeInTheDocument();
    expect(operations.listInvites).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when there are no invitations", async () => {
    renderPanel(stubOperations({ listInvites: vi.fn(async () => []) }));

    expect(await screen.findByText("No invitations yet")).toBeInTheDocument();
  });

  it("shows the error state for a failed list load, and its retry reloads the list", async () => {
    const listInvites = vi
      .fn<AdminOperations["listInvites"]>()
      .mockRejectedValueOnce(new OperationError("retryable", "down", 500))
      .mockResolvedValueOnce([invite()]);
    renderPanel(stubOperations({ listInvites }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("row", { name: /pending@example.com/ })).toBeInTheDocument();
    expect(listInvites).toHaveBeenCalledTimes(2);
  });
});
