import type { ComponentType } from "react";

export interface ViewRendererProps {
  viewId: string;
  databaseId: string;
}

export type ViewRenderer = ComponentType<ViewRendererProps>;

export class ViewTypeRegistry {
  private readonly renderers = new Map<string, ViewRenderer>();

  register(viewType: string, renderer: ViewRenderer): void {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(viewType)) {
      throw new Error(`View type '${viewType}' must be kebab-case`);
    }
    if (this.renderers.has(viewType)) {
      throw new Error(`A renderer is already registered for '${viewType}'`);
    }
    this.renderers.set(viewType, renderer);
  }

  get(viewType: string): ViewRenderer | undefined {
    return this.renderers.get(viewType);
  }
}

export const registry = new ViewTypeRegistry();
