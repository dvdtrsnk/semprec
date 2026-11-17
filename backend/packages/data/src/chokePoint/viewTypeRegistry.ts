import type { ZodType } from "zod";
import { galleryViewConfigSchema } from "../views/galleryViewConfig.js";

// The related-row contributor registry is re-exported here because the package barrel, which
// re-exports this module whole, is at its line cap.
export {
  registerRelatedRowContributor,
  type RelatedCollectionRow,
  type RelatedContributorContext,
  type RelatedRowContributor,
} from "./relatedContributors.js";

/**
 * Custom view types by key. The built-in types are always known; any other `type` must be
 * registered here before a view of it can be created.
 */
export const BUILTIN_VIEW_TYPES = ["table", "board", "calendar", "list", "gallery"] as const;

export interface ViewTypeService {
  /** Called with the view's already schema-validated common config, before it is persisted. */
  validateConfig?(config: Record<string, unknown>): void;
}

export interface ViewTypeDefinition {
  /** Optional zod schema for this type's own config, beyond the common fields in viewConfig.ts. */
  configSchema?: ZodType<unknown>;
  service?: ViewTypeService;
  /** Config fields holding database / item ids; each must resolve inside the caller's tenant. */
  referenceFields?: { databaseIds?: readonly string[]; itemIds?: readonly string[] };
  /** Opaque identifier the client resolves to its renderer component; the backend never interprets it. */
  clientComponent?: string;
}

export type ViewTypeRegistry = Map<string, ViewTypeDefinition>;

/** Definitions of built-in types that validate their own config; the other built-ins only use the common fields. */
export const BUILTIN_VIEW_TYPE_DEFINITIONS: Readonly<Record<string, ViewTypeDefinition>> = {
  gallery: { configSchema: galleryViewConfigSchema, clientComponent: "galleryGrid" },
};

export function createViewTypeRegistry(): ViewTypeRegistry {
  return new Map();
}

export function isBuiltinViewType(type: string): boolean {
  return (BUILTIN_VIEW_TYPES as readonly string[]).includes(type);
}

export function isKnownViewType(registry: ViewTypeRegistry, type: string): boolean {
  return isBuiltinViewType(type) || registry.has(type);
}

export function getViewTypeDefinition(registry: ViewTypeRegistry, type: string): ViewTypeDefinition | undefined {
  if (registry.has(type)) return registry.get(type);
  return Object.hasOwn(BUILTIN_VIEW_TYPE_DEFINITIONS, type) ? BUILTIN_VIEW_TYPE_DEFINITIONS[type] : undefined;
}

export function registerViewType(registry: ViewTypeRegistry, type: string, definition: ViewTypeDefinition): void {
  if (isBuiltinViewType(type)) {
    throw new Error(`'${type}' is a built-in view type and cannot be re-registered`);
  }
  registry.set(type, definition);
}
