import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate, type Translate } from "../../i18n/index.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";
import type {
  ItemAutomationErrorCount,
  MailboxHealthStatus,
  ProcessHealthStatus,
  SystemHealthOperations,
  SystemHealthReport,
} from "../../api/systemHealthOperations.js";

function ProcessRow({ t, process }: { t: Translate; process: ProcessHealthStatus }) {
  const label = !process.present
    ? t("systemStatus.processes.absent")
    : process.stale
      ? t("systemStatus.processes.stale")
      : t("systemStatus.processes.present");
  return (
    <li
      className={
        process.present && !process.stale ? "system-status__row" : "system-status__row system-status__row--degraded"
      }
    >
      <span>{process.process}</span>
      <span>{label}</span>
      {process.version !== null ? (
        <span>{t("systemStatus.processes.version", { version: process.version })}</span>
      ) : null}
    </li>
  );
}

function ItemAutomationRow({ t, row }: { t: Translate; row: ItemAutomationErrorCount }) {
  return (
    <li className="system-status__row system-status__row--degraded">
      {t("systemStatus.itemAutomation.row", { databaseId: row.databaseId, count: row.errorCount })}
    </li>
  );
}

function MailboxRow({ t, mailbox }: { t: Translate; mailbox: MailboxHealthStatus }) {
  const hasError = mailbox.lastError !== null;
  return (
    <li className={hasError ? "system-status__row system-status__row--degraded" : "system-status__row"}>
      <span>{mailbox.mailboxItemId}</span>
      <span>{hasError ? t("systemStatus.mailboxes.error") : t("systemStatus.mailboxes.ok")}</span>
    </li>
  );
}

/**
 * The System page's status block (issue #170), rendered beside the AI usage block from a plain
 * live snapshot (`GET /api/system-health`, no persisted samples). `alertingChecks` is the
 * authoritative degraded signal — it comes from issue #169's hysteresis-managed state machine,
 * so this panel names degraded components from it rather than inventing its own thresholds over
 * the raw counts shown alongside it.
 */
export function SystemStatusPanel({ operations }: { operations: SystemHealthOperations }) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(() => operations.getSystemHealthReport(), []);

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const report: SystemHealthReport = resource.value;
  // `alertingChecks` belongs in this guard even though it is not a monitored *component*:
  // an alerting check with no processes and no mailboxes to attribute it to is still an
  // active degraded signal, and the empty state would hide it behind "nothing is monitored".
  const isEmpty = report.processes.length === 0 && report.mailboxes.length === 0 && report.alertingChecks.length === 0;
  if (isEmpty) return <EmptyState message={t("systemStatus.empty")} />;

  const degraded = report.alertingChecks.length > 0;

  return (
    <section className="system-status">
      <h1>{t("systemStatus.title")}</h1>
      <p className={degraded ? "system-status__summary system-status__summary--degraded" : "system-status__summary"}>
        {degraded ? t("systemStatus.degraded", { count: report.alertingChecks.length }) : t("systemStatus.healthy")}
      </p>
      <p className="system-status__generatedAt">{t("systemStatus.generatedAt", { when: report.generatedAt })}</p>

      {degraded ? (
        <ul className="system-status__alerts">
          {report.alertingChecks.map((check) => (
            <li key={check.checkKey} className="system-status__row system-status__row--degraded">
              {check.checkKey}
            </li>
          ))}
        </ul>
      ) : null}

      <h2>{t("systemStatus.processes.title")}</h2>
      <ul>
        {report.processes.map((process) => (
          <ProcessRow key={process.process} t={t} process={process} />
        ))}
      </ul>

      <h2>{t("systemStatus.queue.title")}</h2>
      <ul>
        {/*
          Pending is a plain queue depth, not a fault count: there is no number of pending
          jobs that is wrong on its own, which is why this row carries no degraded styling.
          A backlog that has become a fault arrives as the `queue_backlog` alerting check,
          listed above. Overdue and permanent below are different — each is already a count
          of jobs in a bad state, so a non-zero value is itself the signal.
        */}
        <li className="system-status__row">{t("systemStatus.queue.pending", { count: report.queue.pending })}</li>
        <li
          className={
            report.queue.overdue > 0 ? "system-status__row system-status__row--degraded" : "system-status__row"
          }
        >
          {t("systemStatus.queue.overdue", { count: report.queue.overdue })}
        </li>
        <li
          className={
            report.queue.permanent > 0 ? "system-status__row system-status__row--degraded" : "system-status__row"
          }
        >
          {t("systemStatus.queue.permanent", { count: report.queue.permanent })}
        </li>
      </ul>

      <h2>{t("systemStatus.itemAutomation.title")}</h2>
      {report.itemAutomationErrorsByDatabase.length === 0 ? (
        <p>{t("systemStatus.itemAutomation.empty")}</p>
      ) : (
        <ul>
          {report.itemAutomationErrorsByDatabase.map((row) => (
            <ItemAutomationRow key={row.databaseId} t={t} row={row} />
          ))}
        </ul>
      )}

      <h2>{t("systemStatus.agentRunErrors.title")}</h2>
      <p className={report.agentRunErrors7d > 0 ? "system-status__summary--degraded" : undefined}>
        {t("systemStatus.agentRunErrors.count", { count: report.agentRunErrors7d })}
      </p>

      <h2>{t("systemStatus.mailboxes.title")}</h2>
      {report.mailboxes.length === 0 ? (
        <p>{t("systemStatus.mailboxes.empty")}</p>
      ) : (
        <ul>
          {report.mailboxes.map((mailbox) => (
            <MailboxRow key={mailbox.mailboxItemId} t={t} mailbox={mailbox} />
          ))}
        </ul>
      )}
    </section>
  );
}
