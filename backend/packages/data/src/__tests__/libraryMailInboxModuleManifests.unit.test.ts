import { beforeAll, describe, expect, it } from "vitest";
import { ModuleRegistry } from "@semprec/module-registry";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
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
import {
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
} from "../mail/personLinkingActions.js";
import { SEMPREC_TICK_ACTION_ID } from "../inbox/inboxTickAction.js";

/**
 * Load tests (module-contract issue #227) proving each retrofit manifest for the library,
 * mail sync/mailbox, and Inbox pipeline modules actually loads through
 * `ModuleRegistry.loadModule()` and passes its load-time structural validation — never that
 * a `ModuleManifest` object merely type-checks. Each module is loaded into its own registry
 * so a failure in one never masks or is masked by another; the three together also prove
 * none of the three collide with each other on module id/name/database key/worker name.
 */
function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const LIBRARY_PATH = manifestPath("library/libraryModuleManifest.js");
const MAIL_PATH = manifestPath("mail/mailModuleManifest.js");
const INBOX_PATH = manifestPath("inbox/inboxModuleManifest.js");

const alwaysActive: () => ReadonlySet<string> = () => new Set(["library", "mailSync", "inboxPipeline"]);

describe("library/mail/inbox module manifests (module-contract issue #227)", () => {
  // Warms the three manifests' cold module-graph imports once, so no test's cost depends on order or `-t` filtering
  // (#1237): ~1 s idle; a subset of the 7 graphs measured at up to 10.7 s at load ~25 together, so 30 s is ~3x margin.
  beforeAll(async () => {
    await Promise.all([LIBRARY_PATH, MAIL_PATH, INBOX_PATH].map((path) => import(path)));
  }, 30_000);

  it("loads Czech and English labels for Books publication year and ISBN", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(LIBRARY_PATH);
    const catalogs = await registry.getCatalogs("library");
    expect(catalogs?.cs["property.books.year.name"]).toBe("Rok");
    expect(catalogs?.en["property.books.year.name"]).toBe("Year");
    expect(catalogs?.cs["property.books.isbn.name"]).toBe("ISBN");
    expect(catalogs?.en["property.books.isbn.name"]).toBe("ISBN");
  });

  it("loads the library manifest with Books/Movies and the library-grid view type", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(LIBRARY_PATH);

    expect(moduleId).toBe("library");
    const databases = await registry.getDatabases();
    expect(databases.map((db) => db.key).sort()).toEqual([BOOKS_MODULE_ID, MOVIES_MODULE_ID].sort());
    expect(databases.find((db) => db.key === BOOKS_MODULE_ID)).toMatchObject({
      icon: "book-open",
      color: "#A2845E",
      overviewOrder: 7,
      switcherOrder: null,
      clientVisible: true,
    });
    expect(databases.find((db) => db.key === MOVIES_MODULE_ID)).toMatchObject({
      icon: "film",
      color: "#FF6482",
      overviewOrder: 8,
      switcherOrder: null,
      clientVisible: true,
    });
    expect(await registry.getViewTypes()).toEqual([LIBRARY_GRID_VIEW_TYPE]);
    expect(await registry.getHeartbeatActions()).toEqual([]);
    expect(await registry.getTasks()).toEqual([]);
    expect(await registry.getMigrations()).toEqual([{ moduleId: "library", migration: "0005_library_module.sql" }]);
  });

  it("loads the mail sync manifest with Mailboxes/Folders/Emails, its own heartbeat actions, and the per-mailbox worker", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(MAIL_PATH);

    expect(moduleId).toBe("mailSync");
    const databases = await registry.getDatabases();
    expect(databases.map((db) => db.key).sort()).toEqual(
      [EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID, THREADS_MODULE_ID].sort(),
    );
    expect(databases.find((db) => db.key === EMAILS_MODULE_ID)).toMatchObject({
      icon: "envelope",
      color: "#007AFF",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
    for (const key of [MAILBOXES_MODULE_ID, FOLDERS_MODULE_ID, THREADS_MODULE_ID]) {
      const db = databases.find((d) => d.key === key)!;
      expect(db.icon).toBeUndefined();
      expect(db.color).toBeUndefined();
      expect(db.overviewOrder).toBeUndefined();
      expect(db.switcherOrder).toBeUndefined();
      expect(db.clientVisible).toBeUndefined();
    }
    expect(await registry.getViewTypes()).toEqual([MAILBOX_CLIENT_VIEW_TYPE]);
    expect(await registry.getHeartbeatActions()).toEqual([
      MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
      MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
    ]);
    expect(await registry.getTasks()).toEqual([]);
    const workers = await registry.getWorkers();
    expect(workers).toEqual([
      { moduleId: "mailSync", name: "semprec-mailsync", handlerExport: "createNoopMailLiveSyncLifecycleFactory" },
    ]);
    expect(await registry.getMigrations()).toEqual([
      { moduleId: "mailSync", migration: "0006_mail_sync.sql" },
      { moduleId: "mailSync", migration: "0007_mail_delivered_to_and_dsn.sql" },
    ]);
  });

  it("loads the Threads database and property labels in both locales", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(MAIL_PATH);
    const catalogs = await registry.getCatalogs("mailSync");
    expect(catalogs?.en["database.threads.name"]).toBe("Threads");
    expect(catalogs?.cs["database.threads.name"]).toBe("Vlákna");
    expect(catalogs?.en["property.threads.name.name"]).toBe("Name");
    expect(catalogs?.cs["property.threads.name.name"]).toBe("Název");
    expect(catalogs?.en["property.threads.project.name"]).toBe("Project");
    expect(catalogs?.cs["property.threads.project.name"]).toBe("Projekt");
    expect(catalogs?.en["property.threads.company.name"]).toBe("Company");
    expect(catalogs?.cs["property.threads.company.name"]).toBe("Firma");
  });

  it("loads the Inbox pipeline manifest with Inbox/Inbox item types/Processing proposals, semprec.tick, and journal-inbox", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(INBOX_PATH);

    expect(moduleId).toBe("inboxPipeline");
    const databases = await registry.getDatabases();
    expect(databases.map((db) => db.key).sort()).toEqual(
      [INBOX_ITEM_TYPES_MODULE_ID, INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID].sort(),
    );
    expect(await registry.getViewTypes()).toEqual([JOURNAL_INBOX_VIEW_TYPE]);
    expect(await registry.getHeartbeatActions()).toEqual([SEMPREC_TICK_ACTION_ID]);
    expect(await registry.getTasks()).toEqual([]);
    expect(await registry.getMigrations()).toEqual([
      { moduleId: "inboxPipeline", migration: "0010_inbox_type_processing.sql" },
    ]);
  });

  it("loads all three manifests together into one registry with no id/name/database-key/worker collisions", async () => {
    const registry = new ModuleRegistry(alwaysActive);

    await registry.loadModule(LIBRARY_PATH);
    await registry.loadModule(MAIL_PATH);
    await registry.loadModule(INBOX_PATH);

    expect(registry.listModuleIds().sort()).toEqual(["inboxPipeline", "library", "mailSync"]);
    expect((await registry.getDatabases()).length).toBe(9);
  });
});
