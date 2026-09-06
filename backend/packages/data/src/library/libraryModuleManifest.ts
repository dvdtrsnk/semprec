import type { ModuleManifest } from "@semprec/module-registry";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";

/**
 * Retrofit manifest (module-contract issue #227) for the library module (issue #25): Books
 * and Movies/TV, two instantiations of the generic library contract (see
 * `libraryModuleContract.ts` — an older, unrelated "contract" concept: per-instance
 * property-key slots, not this `ModuleManifest`), sharing `item_automation`
 * (`0005_library_module.sql`) and the `library-grid` view type
 * (`views/libraryGridViewType.ts`). Its cover/metadata heartbeat actions
 * (`core.libraryMetadataTrigger`, `core.libraryMetadataRetrySweep`,
 * `libraryMetadataActions.ts`) and job (`processLibraryMetadata`,
 * `CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS`) are registered as core actions/tasks, not
 * module-declared ones — the same reason the docs manifest (#226) excludes its cron tasks —
 * so this manifest declares no `heartbeatActions`/`taskNames`. Authoring this manifest
 * changes no behavior.
 */
export const manifest: ModuleManifest = {
  id: "library",
  version: "1.0.0",
  name: "Library",
  removable: false,
  systemProject: true,
  databases: [
    { key: BOOKS_MODULE_ID, name: "Books" },
    { key: MOVIES_MODULE_ID, name: "Movies/TV" },
  ],
  capabilities: [],
  agentTools: [],
  viewTypes: [LIBRARY_GRID_VIEW_TYPE],
  migrations: ["0005_library_module.sql"],
};
