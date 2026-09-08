import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate } from "../../i18n/index.js";
import type { AgentRunOperations } from "../../api/agentRunOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";
import "./agentRunDetail.css";

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/**
 * A single agent run's detail (issue #132): the destination the global approval queue's
 * "source agent-run link" points at. Read-only — task, status, timestamps, and result.
 */
export function AgentRunDetail({ agentRunId, operations }: { agentRunId: string; operations: AgentRunOperations }) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(() => operations.getAgentRun(agentRunId), [operations, agentRunId]);

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;
  if (resource.value === null) return <EmptyState message={t("agentRun.notFound")} />;

  const run = resource.value;

  return (
    <section className="agent-run-detail">
      <h1>{t("agentRun.title")}</h1>
      <dl className="agent-run-detail__fields">
        <dt>{t("agentRun.field.task")}</dt>
        <dd>{run.task}</dd>
        <dt>{t("agentRun.field.status")}</dt>
        <dd>{t(`agentRun.status.${run.status}`)}</dd>
        <dt>{t("agentRun.field.triggeredBy")}</dt>
        <dd>{t(`agentRun.triggeredBy.${run.triggeredBy}`)}</dd>
        <dt>{t("agentRun.field.startedAt")}</dt>
        <dd>{formatTimestamp(run.startedAt)}</dd>
        <dt>{t("agentRun.field.finishedAt")}</dt>
        <dd>{formatTimestamp(run.finishedAt)}</dd>
        <dt>{t("agentRun.field.result")}</dt>
        <dd>{run.result ?? t("agentRun.result.none")}</dd>
      </dl>
    </section>
  );
}
