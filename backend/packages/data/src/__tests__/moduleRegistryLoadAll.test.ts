import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "@semprec/module-registry";
import { TEN_DATABASE_MODULE_IDS } from "../seed/tenDatabaseKeys.js";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { INBOX_ITEM_TYPES_MODULE_ID, INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";

/**
 * The "load-all" structural test module-contract issue #115 requires: every retrofit manifest
 * authored across #226/#227 for the modules delivered by source issues #21-#28 loaded together
 * into one `ModuleRegistry`, proving the whole real set composes without id/name/database-key/
 * worker/heartbeat-rule-kind collisions — something `coreModuleManifests.test.ts` and
 * `libraryMailInboxModuleManifests.test.ts` each prove only within their own four/three-manifest
 * subset, never across all seven together.
 */
function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const ALL_MODULE_IDS = ["schemaCore", "views", "docs", "systemDatabases", "library", "mailSync", "inboxPipeline"];

const MANIFEST_PATHS = [
  manifestPath("chokePoint/schemaCoreModuleManifest.js"),
  manifestPath("views/viewsModuleManifest.js"),
  manifestPath("docs/docsModuleManifest.js"),
  manifestPath("seed/systemDatabasesModuleManifest.js"),
  manifestPath("library/libraryModuleManifest.js"),
  manifestPath("mail/mailModuleManifest.js"),
  manifestPath("inbox/inboxModuleManifest.js"),
];

async function loadAll(getActiveModuleIds: () => ReadonlySet<string>): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(getActiveModuleIds);
  for (const path of MANIFEST_PATHS) {
    await registry.loadModule(path);
  }
  return registry;
}

const alwaysActive: () => ReadonlySet<string> = () => new Set(ALL_MODULE_IDS);

describe("all module manifests loaded together (module-contract issue #115)", () => {
  it("loads every manifest from #226/#227 into one registry with no cross-manifest collisions", async () => {
    const registry = await loadAll(alwaysActive);

    expect(registry.listModuleIds().sort()).toEqual([...ALL_MODULE_IDS].sort());

    const databaseKeys = (await registry.getDatabases()).map((db) => db.key).sort();
    expect(databaseKeys).toEqual(
      [
        ...TEN_DATABASE_MODULE_IDS,
        BOOKS_MODULE_ID,
        MOVIES_MODULE_ID,
        EMAILS_MODULE_ID,
        FOLDERS_MODULE_ID,
        MAILBOXES_MODULE_ID,
        INBOX_ITEM_TYPES_MODULE_ID,
        INBOX_MODULE_ID,
        PROCESSING_PROPOSALS_MODULE_ID,
      ].sort(),
    );

    expect((await registry.getViewTypes()).sort()).toEqual(
      [...BUILTIN_VIEW_TYPES, TEMPORAL_SWITCHER_VIEW_TYPE, LIBRARY_GRID_VIEW_TYPE, MAILBOX_CLIENT_VIEW_TYPE, JOURNAL_INBOX_VIEW_TYPE].sort(),
    );
  });

  it("excludes an inactive module from every projection while other modules stay unaffected", async () => {
    const activeExceptLibrary = new Set(ALL_MODULE_IDS.filter((id) => id !== "library"));
    const registry = await loadAll(() => activeExceptLibrary);

    const databaseKeys = (await registry.getDatabases()).map((db) => db.key);
    expect(databaseKeys).not.toContain(BOOKS_MODULE_ID);
    expect(databaseKeys).not.toContain(MOVIES_MODULE_ID);
    expect(databaseKeys).toEqual(expect.arrayContaining([...TEN_DATABASE_MODULE_IDS, EMAILS_MODULE_ID, INBOX_MODULE_ID]));

    expect(await registry.getViewTypes()).not.toContain(LIBRARY_GRID_VIEW_TYPE);
    expect(await registry.getMigrations()).not.toContainEqual(expect.objectContaining({ moduleId: "library" }));

    // the module is still loaded (its identifiers stay claimed) — only its projected
    // participation is excluded, matching `ModuleRegistry`'s "structural load vs. active
    // participation" split.
    expect(registry.listModuleIds()).toContain("library");
    expect(await registry.listActiveModuleIds()).not.toContain("library");
  });

  it("re-activating a previously excluded module restores its projections without reloading", async () => {
    let active = new Set(ALL_MODULE_IDS.filter((id) => id !== "docs"));
    const registry = await loadAll(() => active);

    expect((await registry.getMigrations()).some((m) => m.moduleId === "docs")).toBe(false);

    active = new Set(ALL_MODULE_IDS);
    expect((await registry.getMigrations()).some((m) => m.moduleId === "docs")).toBe(true);
  });
});
