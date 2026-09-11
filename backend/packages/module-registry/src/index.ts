export { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalog, type ModuleCatalogs } from "./catalog.js";
export type {
  ModuleManifest,
  ModuleDatabaseDescriptor,
  ModuleAgentToolDescriptor,
  ModuleTaskDescriptor,
  ModuleWorkerDescriptor,
  ModuleHeartbeatRuleKindDescriptor,
  ModuleDataMigrationDescriptor,
  ModuleCustomRouteDescriptor,
  CustomRouteMethod,
  CustomRouteJustification,
} from "./manifest.js";
export { moduleManifestSchema, CUSTOM_ROUTE_METHODS, CUSTOM_ROUTE_JUSTIFICATIONS } from "./manifest.js";
export {
  ModuleRegistry,
  type ActiveModuleIdsSource,
  type ModuleRegistryOptions,
  type ModuleDatabaseProjection,
  type ModuleAgentToolProjection,
  type ModuleTaskProjection,
  type ModuleWorkerProjection,
  type ModuleMigrationProjection,
  type ModuleDataMigrationProjection,
  type ModuleTaskDefinition,
  type ModuleHeartbeatRuleKindDefinition,
  type ModuleDataMigrationDefinition,
  type ModuleCustomRouteProjection,
  type ModuleCustomRouteDefinition,
} from "./registry.js";
