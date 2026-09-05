import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { useTranslate } from "../i18n/index.js";
import type { GenericOperations } from "../api/genericOperations.js";
import { useAsyncResource } from "./mailbox/useAsyncResource.js";
import { resolveViewRenderer, type ViewRegistry } from "./viewRegistry.js";

/**
 * Loads a view through the generic view operation and hands it to whichever renderer the
 * registry resolves for it. A view type this client has no renderer for is an `unavailable`
 * state, not a fallback to some other renderer that would misread its config.
 */
export function ViewHost({ viewId, operations, registry }: { viewId: string; operations: GenericOperations; registry: ViewRegistry }) {
  const t = useTranslate();
  const { resource, reload } = useAsyncResource(() => operations.getView(viewId), [viewId]);

  if (resource.status === "loading") return <LoadingState />;
  if (resource.status === "failed") return <ErrorState error={resource.error} onRetry={reload} />;

  const view = resource.value;
  const Renderer = resolveViewRenderer(registry, view);
  if (!Renderer) return <EmptyState message={t("state.unavailable.title")} />;
  return <Renderer view={view} operations={operations} />;
}
