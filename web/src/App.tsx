import { I18nProvider, resolveLocale } from "./i18n/index.js";
import type { GenericOperations } from "./api/genericOperations.js";
import type { AiUsageOperations } from "./api/aiUsageOperations.js";
import type { McpAgentPageOperations } from "./api/mcpAgentPageOperations.js";
import { ViewHost } from "./views/ViewHost.js";
import { createDefaultViewRegistry } from "./views/registerViews.js";
import { UtilizationPage } from "./views/aiUsage/UtilizationPage.js";
import { AgentPage } from "./views/agentPage/AgentPage.js";
import "./styles/tokens.css";
import "./styles/app.css";

const registry = createDefaultViewRegistry();

export interface AgentPageRoute {
  projectItemId: string;
  databaseId: string;
  mcpOperations: McpAgentPageOperations;
}

export function App({
  viewId,
  operations,
  aiUsageOperations,
  agentPage,
  languages = navigator.languages,
}: {
  viewId: string;
  operations: GenericOperations;
  /** Present only when the composition root routed to the System page's Utilization graph (issue #121) rather than an item/view id. */
  aiUsageOperations?: AiUsageOperations;
  /** Present only when the composition root routed to a project's AGENT page (issue #127) rather than an item/view id. */
  agentPage?: AgentPageRoute;
  languages?: readonly string[];
}) {
  let content;
  if (aiUsageOperations) {
    content = <UtilizationPage operations={aiUsageOperations} />;
  } else if (agentPage) {
    content = (
      <AgentPage
        projectItemId={agentPage.projectItemId}
        databaseId={agentPage.databaseId}
        genericOperations={operations}
        mcpOperations={agentPage.mcpOperations}
      />
    );
  } else {
    content = <ViewHost viewId={viewId} operations={operations} registry={registry} />;
  }

  return <I18nProvider locale={resolveLocale(languages)}>{content}</I18nProvider>;
}
