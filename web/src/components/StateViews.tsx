import { useTranslate } from "../i18n/index.js";
import type { OperationError } from "../api/genericOperations.js";

/**
 * The three non-content states every pane in the client renders the same way: loading,
 * empty, and failed. Failure splits by the error's kind — an `unavailable` failure offers no
 * retry, because retrying an absent or forbidden resource only repeats the same answer.
 */

export function LoadingState({ label }: { label?: string }) {
  const t = useTranslate();
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      {label ?? t("state.loading")}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="state state--empty" role="status">
      {message}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: OperationError; onRetry?: () => void }) {
  const t = useTranslate();
  const unavailable = error.kind === "unavailable";
  return (
    <div className={`state state--error${unavailable ? " state--unavailable" : ""}`} role="alert">
      <p className="state__title">{unavailable ? t("state.unavailable.title") : t("state.error.title")}</p>
      <p className="state__detail">{error.message}</p>
      {!unavailable && onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          {t("state.retry")}
        </button>
      ) : null}
    </div>
  );
}
