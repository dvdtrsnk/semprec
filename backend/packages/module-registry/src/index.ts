export type {
  ModuleManifest,
  ModuleDatabaseDescriptor,
  ModuleAgentToolDescriptor,
  ModuleTaskDescriptor,
  ModuleWorkerDescriptor,
  ModuleHeartbeatRuleKindDescriptor,
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
  type ModuleTaskDefinition,
  type ModuleHeartbeatRuleKindDefinition,
} from "./registry.js";
