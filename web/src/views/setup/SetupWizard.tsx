import { useId, useState, type FormEvent } from "react";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { SetupOperations } from "../../api/setupOperations.js";
import "./setup.css";

type WizardState =
  { status: "form"; submitting: boolean; error: string | null } | { status: "notFound" } | { status: "success" };

const NOT_FOUND_STATUS = 404;

/**
 * The `/setup` wizard (issue #234): opened with the bootstrap token as `?token=`, it collects
 * email and password and hands both, plus the token, to the #233 API — no account-creation
 * logic lives here. A 404 (already bootstrapped, or a wrong token — the API never distinguishes
 * the two) renders the not-found state instead of the form; success hands off to the login
 * page without creating a session of its own.
 */
export function SetupWizard({ token, operations }: { token: string; operations: SetupOperations }) {
  const t = useTranslate();
  const ids = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<WizardState>({ status: "form", submitting: false, error: null });

  if (state.status === "notFound") {
    return (
      <section className="setup setup--not-found">
        <h1>{t("setup.title")}</h1>
        <p role="alert">{t("setup.notFound")}</p>
      </section>
    );
  }

  if (state.status === "success") {
    return (
      <section className="setup setup--success">
        <h1>{t("setup.title")}</h1>
        <p role="status">{t("setup.success")}</p>
        <a className="button" href="?page=login">
          {t("setup.success.login")}
        </a>
      </section>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ status: "form", submitting: true, error: null });
    try {
      await operations.setupAccount({ token, email, password });
      setState({ status: "success" });
    } catch (error) {
      const operationError = toOperationError(error);
      if (operationError.status === NOT_FOUND_STATUS) {
        setState({ status: "notFound" });
        return;
      }
      setState({ status: "form", submitting: false, error: operationError.message });
    }
  };

  return (
    <section className="setup">
      <h1>{t("setup.title")}</h1>
      <form className="setup__form" onSubmit={onSubmit}>
        <div className="setup__field">
          <label htmlFor={`${ids}-email`}>{t("setup.email")}</label>
          <input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="username"
            value={email}
            disabled={state.submitting}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="setup__field">
          <label htmlFor={`${ids}-password`}>{t("setup.password")}</label>
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
          <p className="setup__error" role="alert">
            {state.error}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={state.submitting}>
          {state.submitting ? t("setup.submitting") : t("setup.submit")}
        </button>
      </form>
    </section>
  );
}
