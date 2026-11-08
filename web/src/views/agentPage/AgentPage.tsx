import { EmptyState, ErrorState, LoadingState } from "../../components/StateViews.js";
import { useTranslate } from "../../i18n/index.js";
import type { GenericOperations } from "../../api/genericOperations.js";
import type { McpAgentPageOperations } from "../../api/mcpAgentPageOperations.js";
import { useAsyncResource } from "../mailbox/useAsyncResource.js";
import { ToolsBlock } from "./ToolsBlock.js";

function GuidanceBlock({ agents }: { agents: unknown }) {
  const t = useTranslate();
  if (typeof agents !== "string" || agents.trim() === "") {
    return (
      <section className="agent-page__guidance">
        <h2>{t("agentPage.guidance.title")}</h2>
        <EmptyState message={t("agentPage.guidance.empty")} />
      </section>
    );
  }
  return (
    <section className="agent-page__guidance">
      <h2>{t("agentPage.guidance.title")}</h2>
      <p className="agent-page__guidance-text">{agents}</p>
    </section>
  );
}

/**
 * Heartbeats aren't rendered here yet: there is no list-by-project read function in
 * `schedulerStore.ts` and `semprec-api` has no access to the `HeartbeatRuleKindRegistry` a
 * correct read would need to parse `heartbeats.rule` — wiring a module registry into the HTTP
 * service is out of scope for issue #127 (MCP tool grants). This block is a placeholder so the
 * Tools block below it sits in the right position once heartbeats are built.
 */
function HeartbeatsBlock() {
  const t = useTranslate();
  return (
    <section className="agent-page__heartbeats">
      <h2>{t("agentPage.heartbeats.title")}</h2>
      <EmptyState message={t("agentPage.heartbeats.unavailable")} />
    </section>
  );
}

/**
 * A project's AGENT page: guidance from the project item's `agents` property, a heartbeats
 * placeholder, and the Tools block (issue #127) that lists every active MCP tool registration
 * in the system with a checkbox bound to this project's grant.
 */
export function AgentPage({
  projectItemId,
  databaseId,
  genericOperations,
  mcpOperations,
}: {
  projectItemId: string;
  databaseId: string;
  genericOperations: GenericOperations;
  mcpOperations: McpAgentPageOperations;
}) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(
    () => genericOperations.getItem(databaseId, projectItemId),
    [genericOperations, databaseId, projectItemId],
  );

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;
  if (resource.value === null) return <EmptyState message={t("agentPage.notFound")} />;

  const project = resource.value;

  return (
    <div className="agent-page">
      <h1>{typeof project.properties.name === "string" ? project.properties.name : t("agentPage.title")}</h1>
      <GuidanceBlock agents={project.properties.agents} />
      <HeartbeatsBlock />
      <ToolsBlock projectItemId={projectItemId} operations={mcpOperations} />
    </div>
  );
}
