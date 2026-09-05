import { I18nProvider, resolveLocale } from "./i18n/index.js";
import type { GenericOperations } from "./api/genericOperations.js";
import { ViewHost } from "./views/ViewHost.js";
import { createDefaultViewRegistry } from "./views/registerViews.js";
import "./styles/tokens.css";
import "./styles/app.css";

const registry = createDefaultViewRegistry();

export function App({ viewId, operations, languages = navigator.languages }: { viewId: string; operations: GenericOperations; languages?: readonly string[] }) {
  return (
    <I18nProvider locale={resolveLocale(languages)}>
      <ViewHost viewId={viewId} operations={operations} registry={registry} />
    </I18nProvider>
  );
}
