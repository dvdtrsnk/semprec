import { ErrorState, LoadingState } from "../../components/StateViews.js";
import { useLocale, useTranslate } from "../../i18n/index.js";
import { formatDateTime } from "../../i18n/format.js";
import type { AdminOperations } from "../../api/adminOperations.js";
import { ProcessRow, QueueCounts } from "../systemStatus/SystemStatusPanel.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";

/**
 * The operator health panel on the admin page (issue #1082). It reads the global, content-free
 * `GET /api/admin/health` report: the alerting checks by key and time only, the four fixed processes,
 * the global queue, the account counts by status and the three cross-tenant totals. The check
 * `detail` is never rendered here, so the check message is not shown on this page.
 */
export function HealthPanel({ operations }: { operations: AdminOperations }) {
  const t = useTranslate();
  const locale = useLocale();
  const { resource, reload } = useAsyncResource(() => operations.getOperationsHealth(), [operations]);

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const report = resource.value;
  const degraded = report.alertingChecks.length > 0;

  return (
    <section className="admin-health">
      <h2>{t("admin.health.title")}</h2>
      <p className={degraded ? "system-status__summary system-status__summary--degraded" : "system-status__summary"}>
        {degraded
          ? t("admin.health.summaryDegraded", { count: report.alertingChecks.length })
          : t("admin.health.summaryHealthy")}
      </p>
      <p>{t("admin.health.asOf", { when: formatDateTime(locale, report.generatedAt) })}</p>

      <h3>{t("admin.health.checks.title")}</h3>
      {degraded ? (
        <ul className="system-status__alerts">
          {report.alertingChecks.map((check) => (
            <li key={check.checkKey} className="system-status__row system-status__row--degraded">
              <span>{check.checkKey}</span>
              <span>{t("admin.health.checks.changedAt", { when: formatDateTime(locale, check.changedAt) })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("admin.health.checks.empty")}</p>
      )}

      <h3>{t("admin.health.processes.title")}</h3>
      <ul>
        {report.processes.map((process) => (
          <ProcessRow key={process.process} t={t} process={process} />
        ))}
      </ul>

      <h3>{t("admin.health.queue.title")}</h3>
      <ul>
        <QueueCounts t={t} queue={report.queue} />
      </ul>

      <h3>{t("admin.health.tenants.title")}</h3>
      <ul>
        <li>{t("admin.health.tenants.provisioning", { count: report.tenants.provisioning })}</li>
        <li>{t("admin.health.tenants.active", { count: report.tenants.active })}</li>
        <li>{t("admin.health.tenants.suspended", { count: report.tenants.suspended })}</li>
        <li>{t("admin.health.tenants.deleting", { count: report.tenants.deleting })}</li>
      </ul>

      <h3>{t("admin.health.aggregates.title")}</h3>
      <ul>
        <li>{t("admin.health.aggregates.agentRunErrors7d", { count: report.tenantAggregates.agentRunErrors7d })}</li>
        <li>
          {t("admin.health.aggregates.itemAutomationErrors", { count: report.tenantAggregates.itemAutomationErrors })}
        </li>
        <li>
          {t("admin.health.aggregates.alertingTenantChecks", {
            count: report.tenantAggregates.alertingTenantChecks,
          })}
        </li>
      </ul>
    </section>
  );
}
