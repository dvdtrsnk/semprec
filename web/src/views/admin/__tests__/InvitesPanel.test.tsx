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
    listAiBudgets: vi.fn(async () => []),
    setAiBudget: vi.fn(async () => undefined),
    getOperationsHealth: vi.fn(async () => {
      throw new Error("unused");
    }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
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

  it("while a creation is pending, the field and submit are disabled and labelled, and success restores them", async () => {
    const pending = deferred<CreatedInvite>();
    const createInvite = vi.fn<AdminOperations["createInvite"]>(() => pending.promise);
    renderPanel(stubOperations({ createInvite }));
    await screen.findByRole("row", { name: /pending@example.com/ });
    const user = userEvent.setup();

    await submitEmail("first@example.com");

    const field = screen.getByLabelText("Email");
    const submit = screen.getByRole("button", { name: "Creating…" });
    expect(field).toBeDisabled();
    expect(submit).toBeDisabled();
    await user.type(field, "second@example.com");
    await user.click(submit);
    expect(field).toHaveValue("first@example.com");
    expect(createInvite).toHaveBeenCalledTimes(1);

    pending.resolve(created());

    expect(await screen.findByDisplayValue(URL_ONE)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create invitation" })).toBeEnabled();
  });

  it("a rejected pending creation restores the field and submit with the typed email", async () => {
    const pending = deferred<CreatedInvite>();
    renderPanel(stubOperations({ createInvite: vi.fn(() => pending.promise) }));
    await screen.findByRole("row", { name: /pending@example.com/ });

    await submitEmail("taken@example.com");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();

    pending.reject(new OperationError("retryable", "validation_failed", 400));

    expect(await screen.findByRole("alert")).toHaveTextContent("The action failed: validation_failed");
    expect(screen.getByLabelText("Email")).toBeEnabled();
    expect(screen.getByLabelText("Email")).toHaveValue("taken@example.com");
    expect(screen.getByRole("button", { name: "Create invitation" })).toBeEnabled();
  });

  it("while a revocation is pending, every Revoke button is disabled and the clicked one is labelled", async () => {
    const pending = deferred<InviteSummary>();
    const revokeInvite = vi.fn<AdminOperations["revokeInvite"]>(() => pending.promise);
    const operations = stubOperations({
      listInvites: vi.fn(async () => [
        invite({ id: "p1", email: "one@example.com" }),
        invite({ id: "p2", email: "two@example.com" }),
      ]),
      revokeInvite,
    });
    renderPanel(operations);
    const user = userEvent.setup();

    const firstRow = await screen.findByRole("row", { name: /one@example.com/ });
    await user.click(within(firstRow).getByRole("button", { name: "Revoke" }));

    const revoking = within(firstRow).getByRole("button", { name: "Revoking…" });
    const other = within(screen.getByRole("row", { name: /two@example.com/ })).getByRole("button", { name: "Revoke" });
    expect(revoking).toBeDisabled();
    expect(other).toBeDisabled();
    await user.click(other);
    expect(revokeInvite).toHaveBeenCalledTimes(1);

    pending.resolve(invite({ id: "p1", status: "revoked", revokedAt: "2026-10-02T09:00:00.000Z" }));

    await vi.waitFor(() => expect(operations.listInvites).toHaveBeenCalledTimes(2));
    for (const button of await screen.findAllByRole("button", { name: "Revoke" })) expect(button).toBeEnabled();
  });

  it("a rejected pending revocation re-enables every Revoke button", async () => {
    const pending = deferred<InviteSummary>();
    renderPanel(
      stubOperations({
        listInvites: vi.fn(async () => [
          invite({ id: "p1", email: "one@example.com" }),
          invite({ id: "p2", email: "two@example.com" }),
        ]),
        revokeInvite: vi.fn(() => pending.promise),
      }),
    );
    const user = userEvent.setup();

    const firstRow = await screen.findByRole("row", { name: /one@example.com/ });
    await user.click(within(firstRow).getByRole("button", { name: "Revoke" }));
    expect(within(firstRow).getByRole("button", { name: "Revoking…" })).toBeDisabled();

    pending.reject(new OperationError("retryable", "invite_not_pending", 409));

    expect(await screen.findByRole("alert")).toHaveTextContent("The action failed: invite_not_pending");
    const buttons = screen.getAllByRole("button", { name: "Revoke" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toBeEnabled();
  });

  it("revoking the invitation whose link is shown clears the link", async () => {
    const listInvites = vi
      .fn<AdminOperations["listInvites"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([invite({ id: "i-new", email: "new@example.com" })])
      .mockResolvedValue([invite({ id: "i-new", email: "new@example.com", status: "revoked" })]);
    renderPanel(stubOperations({ listInvites, createInvite: vi.fn(async () => created({ emailed: false })) }));
    await screen.findByText("No invitations yet");
    const user = userEvent.setup();

    await submitEmail("new@example.com");
    expect(await screen.findByDisplayValue(URL_ONE)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await vi.waitFor(() => expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument());
    expect(
      screen.queryByText("The invitation was not emailed. Copy the link and pass it on yourself."),
    ).not.toBeInTheDocument();
  });

  it("revoking a different invitation keeps the shown link", async () => {
    const operations = stubOperations();
    renderPanel(operations);
    await screen.findByRole("row", { name: /pending@example.com/ });
    const user = userEvent.setup();

    await submitEmail("new@example.com");
    expect(await screen.findByDisplayValue(URL_ONE)).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("row", { name: /pending@example.com/ })).getByRole("button", { name: "Revoke" }),
    );

    expect(operations.revokeInvite).toHaveBeenCalledWith("i1");
    await vi.waitFor(() => expect(operations.listInvites).toHaveBeenCalledTimes(3));
    expect(screen.getByDisplayValue(URL_ONE)).toBeInTheDocument();
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
