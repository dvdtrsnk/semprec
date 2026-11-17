import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useLocale, useTranslate } from "../../i18n/index.js";
import type { Locale, MessageKey } from "../../i18n/messages.js";
import { formatDateTime } from "../../i18n/format.js";
import { OperationError, toOperationError } from "../../api/genericOperations.js";
import type { AccountOperations, TenantExport, TenantExportStatus } from "../../api/accountOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";

const EXPORT_STATUS_KEYS: Record<TenantExportStatus, MessageKey> = {
  pending: "account.exports.status.pending",
  running: "account.exports.status.running",
  ready: "account.exports.status.ready",
  failed: "account.exports.status.failed",
};

/**
 * The caller's own account page (issue #1083): the data export and self-deletion. Export requests
 * and the download links go through `operations`; deleting the account re-checks the password on
 * the server, and a success hands control to `onAccountDeleted`, which ends the session. The page
 * never touches `window.location` itself.
 */
export function AccountPage({
  operations,
  onAccountDeleted,
}: {
  operations: AccountOperations;
  onAccountDeleted: () => void;
}) {
  return (
    <section className="account-page">
      <ExportSection operations={operations} />
      <DeleteSection operations={operations} onAccountDeleted={onAccountDeleted} />
    </section>
  );
}

function ExportSection({ operations }: { operations: AccountOperations }) {
  const t = useTranslate();
  const locale = useLocale();
  const { resource, reload } = useAsyncResource(() => operations.listExports(), [operations]);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const onRequestExport = async () => {
    setRequesting(true);
    setRequestError(null);
    try {
      await operations.requestExport();
      reload();
    } catch (error) {
      setRequestError(toOperationError(error).message);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <section className="account-exports">
      <h2>{t("account.exports.title")}</h2>
      <p>{t("account.exports.description")}</p>
      <div className="account-exports__actions">
        <button type="button" className="button" onClick={onRequestExport} disabled={requesting}>
          {t("account.exports.request")}
        </button>
        <button type="button" className="button" onClick={reload}>
          {t("account.exports.refresh")}
        </button>
      </div>
      {requestError ? <p role="alert">{t("account.exports.requestFailed", { message: requestError })}</p> : null}

      {resource.status === "loading" ? <LoadingState /> : null}
      {resource.status === "failed" ? <ErrorState error={resource.error} onRetry={reload} /> : null}
      {resource.status === "ready" && resource.value.length === 0 ? (
        <EmptyState message={t("account.exports.empty")} />
      ) : null}
      {resource.status === "ready" && resource.value.length > 0 ? (
        <ul className="account-exports__list">
          {resource.value.map((item) => (
            <ExportRow key={item.id} operations={operations} item={item} locale={locale} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ExportRow({
  operations,
  item,
  locale,
}: {
  operations: AccountOperations;
  item: TenantExport;
  locale: Locale;
}) {
  const t = useTranslate();
  return (
    <li className="account-exports__row">
      <span>{t("account.exports.createdAt", { when: formatDateTime(locale, item.createdAt) })}</span>
      <span>{t(EXPORT_STATUS_KEYS[item.status])}</span>
      {item.status === "ready" ? (
        <>
          <a href={operations.exportDownloadUrl(item.id)} download>
            {t("account.exports.download")}
          </a>
          <span>{t("account.exports.expiresAt", { when: formatDateTime(locale, item.expiresAt) })}</span>
        </>
      ) : null}
    </li>
  );
}

function DeleteSection({
  operations,
  onAccountDeleted,
}: {
  operations: AccountOperations;
  onAccountDeleted: () => void;
}) {
  const t = useTranslate();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await operations.deleteAccount(password);
    } catch (error) {
      setPending(false);
      setPassword("");
      setMessage(deleteFailureMessage(error, t));
      return;
    }
    // The session ends with this call; the page is not shown again, so the pending flag is left set.
    onAccountDeleted();
  };

  return (
    <section className="account-delete">
      <h2>{t("account.delete.title")}</h2>
      <p>{t("account.delete.warning")}</p>
      <form onSubmit={onSubmit}>
        <label>
          {t("account.delete.password")}
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button type="submit" className="button" disabled={pending}>
          {t("account.delete.submit")}
        </button>
      </form>
      {message ? <p role="alert">{message}</p> : null}
    </section>
  );
}

/** Maps a refused deletion to its message: a wrong password (403), the last admin (409), or anything else. */
function deleteFailureMessage(error: unknown, t: ReturnType<typeof useTranslate>): string {
  if (error instanceof OperationError && error.status === 403) return t("account.delete.wrongPassword");
  const message = toOperationError(error).message;
  if (message === "last_admin") return t("account.delete.lastAdmin");
  return t("account.delete.failed", { message });
}
