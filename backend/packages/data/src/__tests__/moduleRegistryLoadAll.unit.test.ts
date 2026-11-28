import { beforeAll, describe, expect, it, vi } from "vitest";
import { ModuleRegistry } from "@alldots/module-registry";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { manifestPath } from "../testSupport/moduleManifestPath.js";
import { CORE_DATABASE_MODULE_IDS } from "../seed/tenDatabaseKeys.js";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import {
  EMAILS_MODULE_ID,
  FOLDERS_MODULE_ID,
  MAILBOXES_MODULE_ID,
  THREADS_MODULE_ID,
} from "../seed/emailModuleKeys.js";
import {
  INBOX_ITEM_TYPES_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";

/** Every module manifest loaded into one registry, proving the whole set composes without collisions. */
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

async function loadAll(getActiveModuleIds: () => ReadonlySet<string>): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(getActiveModuleIds);
  for (const path of MANIFEST_PATHS) {
    await registry.loadModule(path);
  }
  return registry;
}

const alwaysActive: () => ReadonlySet<string> = () => new Set(ALL_MODULE_IDS);

describe("all module manifests loaded together (module-contract issue #115)", () => {
  // Warms the manifests' cold imports once so no test's cost depends on order or `-t` filtering.
  beforeAll(async () => {
    await Promise.all(MANIFEST_PATHS.map((path) => import(path)));
  }, 30_000);

  it("rejects an invalid link rule during full registry loading", async () => {
    const original: unknown = Reflect.get(ModuleRegistry.prototype, "loadModule");
    if (typeof original !== "function") throw new Error("Missing loadModule method");
    const fixture = new URL(
      "../../../module-registry/src/__tests__/fixtures/linkRulesUnknownDatabaseModule.js",
      import.meta.url,
    ).href;
    const spy = vi.spyOn(ModuleRegistry.prototype, "loadModule").mockImplementation(async function (
      this: ModuleRegistry,
      path: string,
    ) {
      const id: unknown = await Reflect.apply(original, this, [path]);
      if (typeof id !== "string") throw new Error("loadModule did not return an id");
      if (id === "calendar") await Reflect.apply(original, this, [fixture]);
      return id;
    });
    try {
      await expect(loadFullModuleRegistry()).rejects.toThrow(/fixtureLink\.unknownDatabase.*noSuchDatabase/);
    } finally {
      spy.mockRestore();
    }
  });

  it("loads every manifest from #226/#227 into one registry with no cross-manifest collisions", async () => {
    const registry = await loadAll(alwaysActive);

    expect(registry.listModuleIds().sort()).toEqual([...ALL_MODULE_IDS].sort());

    const databaseKeys = (await registry.getDatabases()).map((db) => db.key).sort();
    expect(databaseKeys).toEqual(
      [
        ...CORE_DATABASE_MODULE_IDS,
        BOOKS_MODULE_ID,
        MOVIES_MODULE_ID,
        EMAILS_MODULE_ID,
        FOLDERS_MODULE_ID,
        MAILBOXES_MODULE_ID,
        THREADS_MODULE_ID,
        INBOX_ITEM_TYPES_MODULE_ID,
        INBOX_MODULE_ID,
        PROCESSING_PROPOSALS_MODULE_ID,
        CALENDARS_MODULE_ID,
        INVITATIONS_MODULE_ID,
        SUBSCRIBED_EVENTS_MODULE_ID,
        RECIPES_MODULE_ID,
        SLEEP_SETTINGS_MODULE_ID,
        SLEEP_PLANS_MODULE_ID,
        SLEEP_NIGHTS_MODULE_ID,
        PAGES_MODULE_ID,
      ].sort(),
    );

    expect((await registry.getViewTypes()).sort()).toEqual(
      [
        ...BUILTIN_VIEW_TYPES,
        TEMPORAL_SWITCHER_VIEW_TYPE,
        LIBRARY_GRID_VIEW_TYPE,
        MAILBOX_CLIENT_VIEW_TYPE,
        JOURNAL_INBOX_VIEW_TYPE,
      ].sort(),
    );
  });

  it("excludes an inactive module from every projection while other modules stay unaffected", async () => {
    const activeExceptLibrary = new Set(ALL_MODULE_IDS.filter((id) => id !== "library"));
    const registry = await loadAll(() => activeExceptLibrary);

    const databaseKeys = (await registry.getDatabases()).map((db) => db.key);
    expect(databaseKeys).not.toContain(BOOKS_MODULE_ID);
    expect(databaseKeys).not.toContain(MOVIES_MODULE_ID);
    expect(databaseKeys).toEqual(
      expect.arrayContaining([...CORE_DATABASE_MODULE_IDS, EMAILS_MODULE_ID, INBOX_MODULE_ID]),
    );

    expect(await registry.getViewTypes()).not.toContain(LIBRARY_GRID_VIEW_TYPE);
    expect(await registry.getMigrations()).not.toContainEqual(expect.objectContaining({ moduleId: "library" }));

    // The module stays loaded (identifiers claimed); only its projected participation is excluded.
    expect(registry.listModuleIds()).toContain("library");
    expect(await registry.listActiveModuleIds()).not.toContain("library");
  });

  it("re-activating a previously excluded module restores its projections without reloading", async () => {
    let active = new Set(ALL_MODULE_IDS.filter((id) => id !== "docs"));
    const registry = await loadAll(() => active);

    expect((await registry.getDatabases()).some((db) => db.moduleId === "docs")).toBe(false);

    active = new Set(ALL_MODULE_IDS);
    expect((await registry.getDatabases()).some((db) => db.moduleId === "docs")).toBe(true);
  });
});
