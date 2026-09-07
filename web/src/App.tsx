import { I18nProvider, resolveLocale } from "./i18n/index.js";
import type { GenericOperations } from "./api/genericOperations.js";
import type { AiUsageOperations } from "./api/aiUsageOperations.js";
import { ViewHost } from "./views/ViewHost.js";
import { createDefaultViewRegistry } from "./views/registerViews.js";
import { UtilizationPage } from "./views/aiUsage/UtilizationPage.js";
import "./styles/tokens.css";
import "./styles/app.css";

const registry = createDefaultViewRegistry();

export function App({
  viewId,
  operations,
  aiUsageOperations,
  languages = navigator.languages,
}: {
  viewId: string;
  operations: GenericOperations;
  /** Present only when the composition root routed to the System page's Utilization graph (issue #121) rather than an item/view id. */
  aiUsageOperations?: AiUsageOperations;
  languages?: readonly string[];
}) {
  return (
    <I18nProvider locale={resolveLocale(languages)}>
      {aiUsageOperations ? <UtilizationPage operations={aiUsageOperations} /> : <ViewHost viewId={viewId} operations={operations} registry={registry} />}
    </I18nProvider>
  );
}
