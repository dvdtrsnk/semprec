import type { ComponentType } from "react";
import type { GenericOperations, View } from "../api/genericOperations.js";

/**
 * The client half of the backend's view-type registry: it maps the `clientComponent`
 * identifier a registered view type carries (opaque to the backend) to the component that
 * renders it. A view whose component is not registered here renders nothing — the caller
 * decides what to show instead — rather than falling back to some other renderer.
 */
export interface ViewRendererProps {
  view: View;
  operations: GenericOperations;
}

export type ViewRenderer = ComponentType<ViewRendererProps>;

export type ViewRegistry = Map<string, ViewRenderer>;

export function createViewRegistry(): ViewRegistry {
  return new Map();
}

export function registerViewRenderer(registry: ViewRegistry, clientComponent: string, renderer: ViewRenderer): void {
  registry.set(clientComponent, renderer);
}

/**
 * Resolves by the view's `clientComponent` when the backend sent one, falling back to its
 * view type — the two are registered together, so a view type whose registration predates
 * (or omits) a `clientComponent` still resolves.
 */
export function resolveViewRenderer(registry: ViewRegistry, view: Pick<View, "type" | "clientComponent">): ViewRenderer | undefined {
  return (view.clientComponent ? registry.get(view.clientComponent) : undefined) ?? registry.get(view.type);
}
