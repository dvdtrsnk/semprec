import { useEffect, useState, type ReactNode } from "react";
import { I18nProvider, resolveLocale, useTranslate, type Locale } from "./i18n/index.js";
import { toOperationError, type GenericOperations, type OperationError } from "./api/genericOperations.js";
import type { AuthOperations, SessionUser } from "./api/authOperations.js";
import type { AiUsageOperations } from "./api/aiUsageOperations.js";
import type { SystemHealthOperations } from "./api/systemHealthOperations.js";
import type { McpAgentPageOperations } from "./api/mcpAgentPageOperations.js";
import type { ApprovalQueueOperations } from "./api/approvalQueueOperations.js";
import type { AgentRunOperations } from "./api/agentRunOperations.js";
import { ViewHost } from "./views/ViewHost.js";
import { createDefaultViewRegistry } from "./views/registerViews.js";
import { UtilizationPage } from "./views/aiUsage/UtilizationPage.js";
import { SystemStatusPanel } from "./views/systemStatus/SystemStatusPanel.js";
import { AgentPage } from "./views/agentPage/AgentPage.js";
import { ApprovalQueue } from "./views/approvalQueue/ApprovalQueue.js";
import { AgentRunDetail } from "./views/agentRun/AgentRunDetail.js";
import { SetupWizard } from "./views/setup/SetupWizard.js";
import { LoginPage } from "./views/login/LoginPage.js";
import { ErrorState, LoadingState } from "./components/StateViews.js";
import type { SetupOperations } from "./api/setupOperations.js";
import "./styles/tokens.css";
import "./styles/app.css";

const registry = createDefaultViewRegistry();

export interface AgentPageRoute {
  projectItemId: string;
  databaseId: string;
  mcpOperations: McpAgentPageOperations;
}

export interface ApprovalQueueRoute {
  operations: ApprovalQueueOperations;
}

export interface AgentRunRoute {
  agentRunId: string;
  operations: AgentRunOperations;
}

export interface SetupRoute {
  token: string;
  operations: SetupOperations;
}

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: SessionUser }
  | { status: "failed"; error: OperationError };

export function App({
  viewId,
  operations,
  aiUsageOperations,
  systemHealthOperations,
  agentPage,
  approvalQueue,
  agentRun,
  setup,
  auth,
  sessionEvents,
  login,
  languages = navigator.languages,
}: {
  viewId: string;
  operations: GenericOperations;
  /** Present only when the composition root routed to the System page's Utilization graph (issue #121) rather than an item/view id. */
  aiUsageOperations?: AiUsageOperations;
  /** Present alongside `aiUsageOperations` on the System page (issue #170's System status block). */
  systemHealthOperations?: SystemHealthOperations;
  /** Present only when the composition root routed to a project's AGENT page (issue #127) rather than an item/view id. */
  agentPage?: AgentPageRoute;
  /** Present only when the composition root routed to the global approval queue (issue #132) rather than an item/view id. */
  approvalQueue?: ApprovalQueueRoute;
  /** Present only when the composition root routed to a single agent run's detail (issue #132's source agent-run link) rather than an item/view id. */
  agentRun?: AgentRunRoute;
  /** Present only when the composition root routed to the first-account setup wizard (issue #234) rather than an item/view id. */
  setup?: SetupRoute;
  auth: AuthOperations;
  /** Fires `"unauthorized"` whenever an adapter receives a 401 mid-session (see `createSessionFetch`). */
  sessionEvents: EventTarget;
  /** Present only when the composition root routed to `?page=login`. */
  login?: true;
  languages?: readonly string[];
}) {
  const { session, setSession, retry } = useSession(auth, sessionEvents, setup !== undefined);
  const locale: Locale =
    session.status === "authenticated" ? resolveLocale([session.user.locale]) : resolveLocale(languages);

  return (
    <I18nProvider locale={locale}>
      {setup ? (
        <SetupWizard token={setup.token} operations={setup.operations} />
      ) : (
        <SessionGate auth={auth} session={session} setSession={setSession} retry={retry} login={login}>
          <RoutedContent
            viewId={viewId}
            operations={operations}
            aiUsageOperations={aiUsageOperations}
            systemHealthOperations={systemHealthOperations}
            agentPage={agentPage}
            approvalQueue={approvalQueue}
            agentRun={agentRun}
          />
        </SessionGate>
      )}
    </I18nProvider>
  );
}

/**
 * Bootstraps the session from `GET /api/auth/session` on mount and drops back to anonymous when
 * an adapter reports a 401 mid-session. Lifted out of `SessionGate` so `App` can read the session
 * user's locale before the `I18nProvider` that `SessionGate` renders under. Skipped entirely
 * during the setup wizard, which runs before any user exists.
 */
function useSession(
  auth: AuthOperations,
  sessionEvents: EventTarget,
  skip: boolean,
): { session: SessionState; setSession: (session: SessionState) => void; retry: () => void } {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    auth.getSession().then(
      (user) => {
        if (!cancelled) setSession(user ? { status: "authenticated", user } : { status: "anonymous" });
      },
      (error: unknown) => {
        if (!cancelled) setSession({ status: "failed", error: toOperationError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [auth, attempt, skip]);

  useEffect(() => {
    if (skip) return;
    const onUnauthorized = () => {
      setSession((current) => (current.status === "authenticated" ? { status: "anonymous" } : current));
    };
    sessionEvents.addEventListener("unauthorized", onUnauthorized);
    return () => sessionEvents.removeEventListener("unauthorized", onUnauthorized);
  }, [sessionEvents, skip]);

  const retry = () => {
    setSession({ status: "loading" });
    setAttempt((current) => current + 1);
  };

  return { session, setSession, retry };
}

/**
 * The session-driven UI around the routed content: shows the login page for an anonymous
 * visitor, drops back to it when `useSession` observes a mid-session 401, and logs out from the
 * header. The setup wizard never reaches this — it runs before any user exists, so there is no
 * session to ask about.
 */
function SessionGate({
  auth,
  session,
  setSession,
  retry,
  login,
  children,
}: {
  auth: AuthOperations;
  session: SessionState;
  setSession: (session: SessionState) => void;
  retry: () => void;
  login?: true;
  children: ReactNode;
}) {
  const t = useTranslate();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const authenticated = session.status === "authenticated";
  useEffect(() => {
    // There is no router to re-resolve the URL, so leaving `?page=login` is a full navigation.
    if (login && authenticated) window.location.replace("/");
    if (!authenticated) setLogoutError(null);
  }, [login, authenticated]);

  const onLogout = async () => {
    setLogoutError(null);
    try {
      await auth.logout();
    } catch (error) {
      setLogoutError(toOperationError(error).message);
      return;
    }
    setSession({ status: "anonymous" });
  };

  switch (session.status) {
    case "loading":
      return <LoadingState />;
    case "failed":
      return <ErrorState error={session.error} onRetry={retry} />;
    case "anonymous":
      return <LoginPage auth={auth} onLoggedIn={(user) => setSession({ status: "authenticated", user })} />;
    case "authenticated":
      if (login) return <LoadingState />;
      return (
        <>
          <header className="app-header">
            <span className="app-header__user">{t("login.signedInAs", { email: session.user.email })}</span>
            {logoutError ? (
              <span className="app-header__error" role="alert">
                {t("login.logoutFailed", { message: logoutError })}
              </span>
            ) : null}
            <button type="button" className="button" onClick={onLogout}>
              {t("login.logout")}
            </button>
          </header>
          {children}
        </>
      );
  }
}

function RoutedContent({
  viewId,
  operations,
  aiUsageOperations,
  systemHealthOperations,
  agentPage,
  approvalQueue,
  agentRun,
}: {
  viewId: string;
  operations: GenericOperations;
  aiUsageOperations?: AiUsageOperations;
  systemHealthOperations?: SystemHealthOperations;
  agentPage?: AgentPageRoute;
  approvalQueue?: ApprovalQueueRoute;
  agentRun?: AgentRunRoute;
}) {
  let content;
  if (aiUsageOperations) {
    content = (
      <>
        <UtilizationPage operations={aiUsageOperations} />
        {systemHealthOperations ? <SystemStatusPanel operations={systemHealthOperations} /> : null}
      </>
    );
  } else if (agentPage) {
    content = (
      <AgentPage
        projectItemId={agentPage.projectItemId}
        databaseId={agentPage.databaseId}
        genericOperations={operations}
        mcpOperations={agentPage.mcpOperations}
      />
    );
  } else if (approvalQueue) {
    content = <ApprovalQueue operations={approvalQueue.operations} />;
  } else if (agentRun) {
    content = <AgentRunDetail agentRunId={agentRun.agentRunId} operations={agentRun.operations} />;
  } else {
    content = <ViewHost viewId={viewId} operations={operations} registry={registry} />;
  }
  return content;
}
