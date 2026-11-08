import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useLocale, useTranslate, type MessageKey } from "../../i18n/index.js";
import { formatDateTime } from "../../i18n/format.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { AdminOperations, CreatedInvite, InviteStatus, InviteSummary } from "../../api/adminOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";

const INVITE_STATUS_KEYS: Record<InviteStatus, MessageKey> = {
  pending: "admin.invites.status.pending",
  accepted: "admin.invites.status.accepted",
  revoked: "admin.invites.status.revoked",
  expired: "admin.invites.status.expired",
};

/**
 * The invitations panel on the admin page (issue #1080). Creating an invitation shows its link once:
 * the link lives only in this component's state, so it is never logged or written to storage, the
 * next creation replaces it, revoking that invitation clears it, and unmounting drops it. The email
 * field is disabled while a creation is pending, so the success path's clearing cannot discard an
 * address typed after submission. Revoke is offered for pending rows only, and every Revoke button
 * is disabled while one revocation is pending.
 */
export function InvitesPanel({ operations }: { operations: AdminOperations }) {
  const t = useTranslate();
  const locale = useLocale();
  const { resource, reload } = useAsyncResource(() => operations.listInvites(), [operations]);
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setActionError(null);
    try {
      const result = await operations.createInvite(email.trim());
      setCreated(result);
      setEmail("");
      reload();
    } catch (error) {
      setActionError(t("admin.invites.actionFailed", { message: toOperationError(error).message }));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(invite: InviteSummary) {
    setRevokingId(invite.id);
    setActionError(null);
    try {
      await operations.revokeInvite(invite.id);
      // A revoked invitation's link no longer works, so stop offering it; a newer creation stays shown.
      setCreated((current) => (current?.invite.id === invite.id ? null : current));
      reload();
    } catch (error) {
      setActionError(t("admin.invites.actionFailed", { message: toOperationError(error).message }));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section className="admin-invites">
      <h2>{t("admin.invites.title")}</h2>

      <form onSubmit={handleCreate}>
        <label>
          {t("admin.invites.email")}
          <input
            type="email"
            required
            disabled={creating}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button type="submit" disabled={creating}>
          {creating ? t("admin.invites.creating") : t("admin.invites.create")}
        </button>
      </form>

      {created ? (
        <div className="admin-invites__created">
          <label>
            {t("admin.invites.link")}
            <input type="text" readOnly value={created.inviteUrl} />
          </label>
          <p>{t("admin.invites.linkShownOnce")}</p>
          <p>{created.emailed ? t("admin.invites.emailed") : t("admin.invites.notEmailed")}</p>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="admin-invites__error">
          {actionError}
        </p>
      ) : null}

      {renderList()}
    </section>
  );

  function renderList() {
    if (resource.status === "loading") return <LoadingState />;
    if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

    const invites = resource.value;
    if (invites.length === 0) return <EmptyState message={t("admin.invites.empty")} />;

    return (
      <table>
        <thead>
          <tr>
            <th scope="col">{t("admin.invites.email")}</th>
            <th scope="col">{t("admin.invites.createdAt")}</th>
            <th scope="col">{t("admin.invites.expiresAt")}</th>
            <th scope="col">{t("admin.invites.status")}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => (
            <tr key={invite.id}>
              <td>{invite.email}</td>
              <td>{formatDateTime(locale, invite.createdAt)}</td>
              <td>{formatDateTime(locale, invite.expiresAt)}</td>
              <td>{t(INVITE_STATUS_KEYS[invite.status])}</td>
              <td>
                {invite.status === "pending" ? (
                  <button type="button" disabled={revokingId !== null} onClick={() => handleRevoke(invite)}>
                    {revokingId === invite.id ? t("admin.invites.revoking") : t("admin.invites.revoke")}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
}
