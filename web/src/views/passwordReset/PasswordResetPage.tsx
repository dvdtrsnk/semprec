import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { AuthOperations } from "../../api/authOperations.js";
import "./passwordReset.css";

type RequestState = { status: "form"; submitting: boolean; error: string | null } | { status: "sent" };

type ConfirmState =
  { status: "form"; submitting: boolean; error: string | null } | { status: "done" } | { status: "invalid" };

/**
 * The password-reset page (issue #1076). Without a `token` it asks for an email address and posts
 * it to `POST /api/auth/password-reset/request`; the confirmation never says whether the address has
 * an account. With a `token` (the link's `#token=` fragment, read by the composition root) it asks for
 * a new password and posts it with the token to `POST /api/auth/password-reset/consume`.
 *
 * The fragment is stripped from the address bar on mount, so the token is not left in the tab's
 * history entry; the component keeps the `token` prop it received and never re-reads the URL.
 */
export function PasswordResetPage({ token, auth }: { token: string | null; auth: AuthOperations }) {
  if (token === null) return <RequestPasswordReset auth={auth} />;
  return <ConfirmPasswordReset token={token} auth={auth} />;
}

function RequestPasswordReset({ auth }: { auth: AuthOperations }) {
  const t = useTranslate();
  const ids = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<RequestState>({ status: "form", submitting: false, error: null });

  if (state.status === "sent") {
    return (
      <section className="password-reset">
        <h1>{t("passwordReset.title")}</h1>
        <p role="status">{t("passwordReset.request.sent")}</p>
      </section>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ status: "form", submitting: true, error: null });
    try {
      await auth.requestPasswordReset(email);
      setState({ status: "sent" });
    } catch (error) {
      setState({ status: "form", submitting: false, error: toOperationError(error).message });
    }
  };

  return (
    <section className="password-reset">
      <h1>{t("passwordReset.title")}</h1>
      <form className="password-reset__form" onSubmit={onSubmit}>
        <div className="password-reset__field">
          <label htmlFor={`${ids}-email`}>{t("passwordReset.email")}</label>
          <input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="email"
            value={email}
            disabled={state.submitting}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        {state.error ? (
          <p className="password-reset__error" role="alert">
            {t("passwordReset.request.failed", { message: state.error })}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={state.submitting}>
          {state.submitting ? t("passwordReset.request.submitting") : t("passwordReset.request.submit")}
        </button>
      </form>
    </section>
  );
}

function ConfirmPasswordReset({ token, auth }: { token: string; auth: AuthOperations }) {
  const t = useTranslate();
  const ids = useId();
  const [newPassword, setNewPassword] = useState("");
  const [state, setState] = useState<ConfirmState>({ status: "form", submitting: false, error: null });

  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }, []);

  if (state.status === "done") {
    return (
      <section className="password-reset">
        <h1>{t("passwordReset.title")}</h1>
        <p role="status">{t("passwordReset.confirm.success")}</p>
        <a className="button" href="?page=login">
          {t("passwordReset.confirm.continue")}
        </a>
      </section>
    );
  }

  if (state.status === "invalid") {
    return (
      <section className="password-reset">
        <h1>{t("passwordReset.title")}</h1>
        <p role="alert">{t("passwordReset.confirm.invalid")}</p>
        <a className="button" href="?page=password-reset">
          {t("passwordReset.confirm.requestNew")}
        </a>
      </section>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ status: "form", submitting: true, error: null });
    try {
      await auth.resetPassword({ token, newPassword });
      setState({ status: "done" });
    } catch (error) {
      const operationError = toOperationError(error);
      // A rejected token can never succeed, so the form is replaced; any other failure keeps the form
      // enabled, so the same token can be submitted again.
      if (operationError.kind === "unavailable") {
        setState({ status: "invalid" });
        return;
      }
      setState({ status: "form", submitting: false, error: operationError.message });
    }
  };

  return (
    <section className="password-reset">
      <h1>{t("passwordReset.title")}</h1>
      <form className="password-reset__form" onSubmit={onSubmit}>
        <div className="password-reset__field">
          <label htmlFor={`${ids}-password`}>{t("passwordReset.newPassword")}</label>
          <input
            id={`${ids}-password`}
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            disabled={state.submitting}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        {state.error ? (
          <p className="password-reset__error" role="alert">
            {t("passwordReset.confirm.failed", { message: state.error })}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={state.submitting}>
          {state.submitting ? t("passwordReset.confirm.submitting") : t("passwordReset.confirm.submit")}
        </button>
      </form>
    </section>
  );
}
