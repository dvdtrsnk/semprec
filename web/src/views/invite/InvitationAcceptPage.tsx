import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { InvitationOperations } from "../../api/invitationOperations.js";
import "./invite.css";

type PageState =
  | { status: "form"; submitting: boolean; error: string | null }
  | { status: "accepted"; email: string }
  | { status: "invalid" };

/**
 * The invitation acceptance page (issue #1088), opened from an admin's one-time link
 * `?page=invite#token=<token>`. It asks for a password and posts it with the token to
 * `POST /api/invitations/accept` (issue #1087). Accepting creates the account but no session;
 * the success state links to the login page.
 *
 * The fragment is stripped from the address bar and current session-history entry on mount;
 * the component keeps the `token` prop it received and never re-reads the URL. This does not
 * guarantee erasure from global browser history, autocomplete or synced history.
 */
export function InvitationAcceptPage({
  token,
  operations,
}: {
  token: string | null;
  operations: InvitationOperations;
}) {
  const t = useTranslate();
  const ids = useId();
  const [password, setPassword] = useState("");
  const [state, setState] = useState<PageState>(
    token === null ? { status: "invalid" } : { status: "form", submitting: false, error: null },
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }, []);

  if (state.status === "accepted") {
    return (
      <section className="invite">
        <h1>{t("invite.title")}</h1>
        <p role="status">{t("invite.success", { email: state.email })}</p>
        <a className="button" href="?page=login">
          {t("invite.success.login")}
        </a>
      </section>
    );
  }

  // A null token starts in `invalid`; checking it here as well narrows `token` for the submit handler.
  if (state.status === "invalid" || token === null) {
    return (
      <section className="invite">
        <h1>{t("invite.title")}</h1>
        <p role="alert">{t("invite.invalid")}</p>
      </section>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ status: "form", submitting: true, error: null });
    try {
      const { email } = await operations.acceptInvitation({ token, password });
      setState({ status: "accepted", email });
    } catch (error) {
      const operationError = toOperationError(error);
      // An unusable token can never succeed, so the form is replaced; any other failure (a
      // validation message, throttling, a server error) keeps the form, so it can be submitted again.
      if (operationError.kind === "unavailable") {
        setState({ status: "invalid" });
        return;
      }
      setState({ status: "form", submitting: false, error: operationError.message });
    }
  };

  return (
    <section className="invite">
      <h1>{t("invite.title")}</h1>
      <form className="invite__form" onSubmit={onSubmit}>
        <div className="invite__field">
          <label htmlFor={`${ids}-password`}>{t("invite.password")}</label>
          <input
            id={`${ids}-password`}
            type="password"
            required
            autoComplete="new-password"
            value={password}
            disabled={state.submitting}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {state.error ? (
          <p className="invite__error" role="alert">
            {t("invite.failed", { message: state.error })}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={state.submitting}>
          {state.submitting ? t("invite.submitting") : t("invite.submit")}
        </button>
      </form>
    </section>
  );
}
