export type {
  ModuleManifest,
  ModuleDatabaseDescriptor,
  ModuleAgentToolDescriptor,
  ModuleTaskDescriptor,
  ModuleWorkerDescriptor,
} from "./manifest.js";
export { moduleManifestSchema } from "./manifest.js";
export {
  ModuleRegistry,
  type ActiveModuleIdsSource,
  type ModuleDatabaseProjection,
  type ModuleAgentToolProjection,
  type ModuleTaskProjection,
  type ModuleWorkerProjection,
  type ModuleMigrationProjection,
} from "./registry.js";
