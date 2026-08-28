import type { ZodType } from "zod";

/**
 * A temporary stand-in for the full module registry (issue #29), same pattern as
 * ComputedKeyRegistry/ActionRegistry: a plain map from a custom view type's key to its
 * registration triple (config schema / optional server service / client component id),
 * empty until a real module system exists to populate it. The built-in view types are
 * always known without registration; any other `type` must be registered here before a
 * view of that type can be created.
 */
export const BUILTIN_VIEW_TYPES = ["table", "board", "calendar", "list"] as const;

export interface ViewTypeService {
  /** Called with the view's already schema-validated common config, before it is persisted. */
  validateConfig?(config: Record<string, unknown>): void;
}

export interface ViewTypeDefinition {
  /** Optional zod schema for this view type's own config shape, beyond the common fields in viewConfig.ts. */
  configSchema?: ZodType<unknown>;
  service?: ViewTypeService;
  /** Opaque identifier the client resolves to its renderer component; the backend never interprets it. */
  clientComponent?: string;
}

export type ViewTypeRegistry = Map<string, ViewTypeDefinition>;

export function createViewTypeRegistry(): ViewTypeRegistry {
  return new Map();
}

export function isBuiltinViewType(type: string): boolean {
  return (BUILTIN_VIEW_TYPES as readonly string[]).includes(type);
}

export function isKnownViewType(registry: ViewTypeRegistry, type: string): boolean {
  return isBuiltinViewType(type) || registry.has(type);
}

export function registerViewType(registry: ViewTypeRegistry, type: string, definition: ViewTypeDefinition): void {
  if (isBuiltinViewType(type)) {
    throw new Error(`'${type}' is a built-in view type and cannot be re-registered`);
  }
  registry.set(type, definition);
}
