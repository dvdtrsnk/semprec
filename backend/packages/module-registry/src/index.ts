export type {
  ModuleManifest,
  ModuleDatabaseDescriptor,
  ModuleAgentToolDescriptor,
  ModuleTaskDescriptor,
  ModuleWorkerDescriptor,
  ModuleHeartbeatRuleKindDescriptor,
  ModuleDataMigrationDescriptor,
} from "./manifest.js";
export { moduleManifestSchema } from "./manifest.js";
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
} from "./registry.js";
