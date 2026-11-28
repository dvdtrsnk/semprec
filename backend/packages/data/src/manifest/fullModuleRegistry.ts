import { ModuleRegistry } from "@alldots/module-registry";
import { RESERVED_TASK_NAMES } from "../moduleTasks.js";

/**
 * Every module manifest, loaded together (`moduleRegistryLoadAll.unit.test.ts` proves no
 * collisions). There is no module-activation mechanism, so every module is always active.
 */
const ALL_MODULE_IDS = [
  "schemaCore",
  "views",
  "docs",
  "systemDatabases",
  "library",
  "mailSync",
  "inboxPipeline",
  "calendar",
  "recipes",
  "sleep",
];

function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const MANIFEST_PATHS = [
  manifestPath("chokePoint/schemaCoreModuleManifest.js"),
  manifestPath("views/viewsModuleManifest.js"),
  manifestPath("docs/docsModuleManifest.js"),
  manifestPath("seed/systemDatabasesModuleManifest.js"),
  manifestPath("library/libraryModuleManifest.js"),
  manifestPath("mail/mailModuleManifest.js"),
  manifestPath("inbox/inboxModuleManifest.js"),
  manifestPath("calendar/calendarModuleManifest.js"),
  manifestPath("recipes/recipesModuleManifest.js"),
  manifestPath("sleep/sleepModuleManifest.js"),
];

/** A fresh registry per call, since `loadModule` has no unload and a set must never go stale. */
export async function loadFullModuleRegistry(): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(() => new Set(ALL_MODULE_IDS), { reservedTaskNames: RESERVED_TASK_NAMES });
  for (const path of MANIFEST_PATHS) {
    await registry.loadModule(path);
  }
  registry.validateLinkRules();
  return registry;
}
