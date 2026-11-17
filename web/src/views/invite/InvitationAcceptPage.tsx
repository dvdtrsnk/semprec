import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { InvitationOperations } from "../../api/invitationOperations.js";
import "./invite.css";

type AcceptState =
  | { status: "form"; submitting: boolean; error: string | null }
  | { status: "success"; email: string }
  | { status: "invalid" };

/**
 * The invitation acceptance page (issue #1088). An admin's invitation link opens it as
 * `?page=invite#token=<token>`; it asks for a password and posts it with the token to
 * `POST /api/invitations/accept`. Accepting creates the account but starts no session: success
 * names the new account's email and links to the login page.
 *
 * The token travels in the fragment, which the browser never sends to the server. The fragment is
 * cleared from the address bar on mount without adding a history entry, and the component keeps the
 * `token` prop it received instead of re-reading the URL. That does not guarantee erasure from global
 * browser history, autocomplete or synced history.
 *
 * Every unusable token (unknown, expired, revoked or used) gets the same answer, so each one shows a
 * single invalid-link message, with no form and no retry. A missing token shows the same message
 * without sending a request.
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
  const [state, setState] = useState<AcceptState>({ status: "form", submitting: false, error: null });

  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }, []);

  if (token === null || state.status === "invalid") {
    return (
      <section className="invite">
        <h1>{t("invite.title")}</h1>
        <p role="alert">{t("invite.invalid")}</p>
      </section>
    );
  }

  if (state.status === "success") {
    return (
      <section className="invite invite--success">
        <h1>{t("invite.title")}</h1>
        <p role="status">{t("invite.success", { email: state.email })}</p>
        <a className="button" href="?page=login">
          {t("invite.success.login")}
        </a>
      </section>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ status: "form", submitting: true, error: null });
    try {
      const { email } = await operations.acceptInvitation({ token, password });
      setState({ status: "success", email });
    } catch (error) {
      const operationError = toOperationError(error);
      // An unusable token can never succeed, so the form is replaced; any other failure keeps the form
      // enabled, so the same token can be submitted again.
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
            {state.error}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={state.submitting}>
          {state.submitting ? t("invite.submitting") : t("invite.submit")}
        </button>
      </form>
    </section>
  );
}
