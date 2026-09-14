/* eslint-disable react-refresh/only-export-components -- the route parser is inseparable from the component that renders it. */
import { registry, type ViewTypeRegistry } from "./registry.js";
import "./registerViews.js";

export interface GenericViewRouteParams {
  viewId: string;
  databaseId: string;
  viewType: string;
}

/** Reads the generic `?view=…&database=…&type=…` view URL. */
export function resolveGenericViewRoute(params: URLSearchParams): GenericViewRouteParams | null {
  const viewId = params.get("view");
  const databaseId = params.get("database");
  const viewType = params.get("type");
  if (!viewId || !databaseId || !viewType) return null;
  return { viewId, databaseId, viewType };
}

export function GenericViewRoute({
  search = window.location.search,
  viewRegistry = registry,
}: {
  search?: string;
  viewRegistry?: ViewTypeRegistry;
}) {
  const route = resolveGenericViewRoute(new URLSearchParams(search));
  if (!route) return null;

  const Renderer = viewRegistry.get(route.viewType);
  if (!Renderer) return null;
  return <Renderer viewId={route.viewId} databaseId={route.databaseId} />;
}
