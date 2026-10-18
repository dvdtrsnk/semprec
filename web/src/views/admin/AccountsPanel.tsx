import { useCallback, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useLocale, useTranslate, type MessageKey } from "../../i18n/index.js";
import { formatDateTime } from "../../i18n/format.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { AdminAccountSummary, AdminOperations, AdminRole } from "../../api/adminOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";

const ROLE_KEYS: Record<AdminRole, MessageKey> = {
  admin: "admin.accounts.role.admin",
  member: "admin.accounts.role.member",
};

const STATUS_KEYS: Record<AdminAccountSummary["status"], MessageKey> = {
  provisioning: "admin.accounts.status.provisioning",
  active: "admin.accounts.status.active",
  suspended: "admin.accounts.status.suspended",
  deleting: "admin.accounts.status.deleting",
};

/** The refusal the backend answers when the change would leave no active admin (issue #1041). */
const LAST_ADMIN_CODE = "last_admin";

type RowAction = "suspend" | "reactivate" | "changeRole";

interface RowState {
  /** The action in flight for this row; while it is set, every button in the row is disabled. */
  pendingAction: RowAction | null;
  error: string | null;
}

/** Which actions a status offers: nothing while an account is being provisioned or deleted. */
function actionsFor(account: AdminAccountSummary): RowAction[] {
  if (account.status === "active") return ["suspend", "changeRole"];
  if (account.status === "suspended") return ["reactivate", "changeRole"];
  return [];
}

/**
 * The accounts table on the admin page (issue #1079). Each row offers only the actions its status
 * allows. An action is applied on the server and never optimistically: the list reloads after a
 * success, and after a failure the row stays as it was and shows the refusal beside its buttons.
 */
export function AccountsPanel({ operations }: { operations: AdminOperations }) {
  const t = useTranslate();
  const locale = useLocale();
  const { resource, reload } = useAsyncResource(() => operations.listAccounts(), [operations]);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const runAction = useCallback(
    async (account: AdminAccountSummary, action: RowAction) => {
      setRows((prev) => ({ ...prev, [account.userId]: { pendingAction: action, error: null } }));
      try {
        if (action === "suspend") await operations.suspendAccount(account.userId);
        else if (action === "reactivate") await operations.reactivateAccount(account.userId);
        else await operations.changeRole(account.userId, account.role === "admin" ? "member" : "admin");
      } catch (error) {
        const { message } = toOperationError(error);
        const shown =
          message === LAST_ADMIN_CODE ? t("admin.accounts.lastAdmin") : t("admin.accounts.actionFailed", { message });
        setRows((prev) => ({ ...prev, [account.userId]: { pendingAction: null, error: shown } }));
        return;
      }
      setRows((prev) => {
        const next = { ...prev };
        delete next[account.userId];
        return next;
      });
      reload();
    },
    [operations, reload, t],
  );

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const accounts = resource.value;
  if (accounts.length === 0) return <EmptyState message={t("admin.accounts.empty")} />;

  return (
    <section className="admin-accounts">
      <h2>{t("admin.accounts.title")}</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("admin.accounts.email")}</th>
            <th scope="col">{t("admin.accounts.role")}</th>
            <th scope="col">{t("admin.accounts.status")}</th>
            <th scope="col">{t("admin.accounts.createdAt")}</th>
            <th scope="col">{t("admin.accounts.lastSeenAt")}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const row = rows[account.userId];
            const pendingAction = row?.pendingAction ?? null;
            return (
              <tr key={account.userId}>
                <td>{account.email}</td>
                <td>{t(ROLE_KEYS[account.role])}</td>
                <td>{t(STATUS_KEYS[account.status])}</td>
                <td>{formatDateTime(locale, account.createdAt)}</td>
                <td>{formatDateTime(locale, account.lastSeenAt)}</td>
                <td>
                  {actionsFor(account).map((action) => (
                    <button
                      key={action}
                      type="button"
                      disabled={pendingAction !== null}
                      onClick={() => runAction(account, action)}
                    >
                      {pendingAction === action ? t("admin.accounts.action.pending") : actionLabel(account, action)}
                    </button>
                  ))}
                  {row?.error ? (
                    <p role="alert" className="admin-accounts__error">
                      {row.error}
                    </p>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );

  function actionLabel(account: AdminAccountSummary, action: RowAction): string {
    if (action === "suspend") return t("admin.accounts.action.suspend");
    if (action === "reactivate") return t("admin.accounts.action.reactivate");
    return account.role === "admin" ? t("admin.accounts.action.makeMember") : t("admin.accounts.action.makeAdmin");
  }
}
