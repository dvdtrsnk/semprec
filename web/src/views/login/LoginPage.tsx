import { useId, useState, type FormEvent } from "react";
import { useTranslate } from "../../i18n/index.js";
import { toOperationError } from "../../api/genericOperations.js";
import type { AuthOperations, SessionUser } from "../../api/authOperations.js";
import "./login.css";

type LoginError = { kind: "invalid" } | { kind: "failed"; message: string };

const UNAUTHORIZED_STATUS = 401;

/**
 * The login page: email and password go to `POST /api/auth/login`, which sets the session
 * cookie itself. A 401 (unknown email, wrong password or lockout — the API never distinguishes
 * them) keeps the form with the invalid-credentials message; any other failure keeps the form
 * with the failure's own message. Success hands the parsed user to `onLoggedIn`.
 */
export function LoginPage({ auth, onLoggedIn }: { auth: AuthOperations; onLoggedIn: (user: SessionUser) => void }) {
  const t = useTranslate();
  const ids = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    let user: SessionUser;
    try {
      user = await auth.login({ email, password });
    } catch (caught) {
      const operationError = toOperationError(caught);
      setError(
        operationError.status === UNAUTHORIZED_STATUS
          ? { kind: "invalid" }
          : { kind: "failed", message: operationError.message },
      );
      setSubmitting(false);
      return;
    }
    onLoggedIn(user);
  };

  return (
    <section className="login">
      <h1>{t("login.title")}</h1>
      <form className="login__form" onSubmit={onSubmit}>
        <div className="login__field">
          <label htmlFor={`${ids}-email`}>{t("login.email")}</label>
          <input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="username"
            value={email}
            disabled={submitting}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="login__field">
          <label htmlFor={`${ids}-password`}>{t("login.password")}</label>
          <input
            id={`${ids}-password`}
            type="password"
            required
            autoComplete="current-password"
            value={password}
            disabled={submitting}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? (
          <p className="login__error" role="alert">
            {error.kind === "invalid" ? t("login.error.invalid") : t("login.error.failed", { message: error.message })}
          </p>
        ) : null}
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? t("login.submitting") : t("login.submit")}
        </button>
      </form>
    </section>
  );
}
