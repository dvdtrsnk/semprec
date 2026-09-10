import { ModuleRegistry } from "@semprec/module-registry";

/**
 * Every module manifest issues #226/#227 shipped a retrofit for, loaded together — the same set
 * `moduleRegistryLoadAll.unit.test.ts` proves composes with no cross-manifest collisions. There
 * is no DB-backed module-activation mechanism anywhere in this codebase yet (no admin UI, no
 * settings table lists deactivated modules), so "every known module is always active" is the
 * only activation predicate any production caller can honestly use today.
 */
const ALL_MODULE_IDS = ["schemaCore", "views", "docs", "systemDatabases", "library", "mailSync", "inboxPipeline"];

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
];

/**
 * Builds a `ModuleRegistry` with every module manifest loaded and always active (issue #147's
 * `/api/schema` projection needs this: it resolves every database/property/view-type/agent-tool
 * label system-wide, not just one project's or one module's). A fresh registry per call —
 * `ModuleRegistry.loadModule` has no unload, so this is the simplest way to guarantee a caller
 * never sees a stale set from a previous request.
 */
export async function loadFullModuleRegistry(): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(() => new Set(ALL_MODULE_IDS));
  for (const path of MANIFEST_PATHS) {
    await registry.loadModule(path);
  }
  return registry;
}
