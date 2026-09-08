import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "@semprec/module-registry";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
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
  it("loads the library manifest with Books/Movies and the library-grid view type", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(LIBRARY_PATH);

    expect(moduleId).toBe("library");
    const databases = await registry.getDatabases();
    expect(databases.map((db) => db.key).sort()).toEqual([BOOKS_MODULE_ID, MOVIES_MODULE_ID].sort());
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
      [EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID].sort(),
    );
    expect(await registry.getViewTypes()).toEqual([MAILBOX_CLIENT_VIEW_TYPE]);
    expect(await registry.getHeartbeatActions()).toEqual(
      expect.arrayContaining([MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID]),
    );
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
    expect((await registry.getDatabases()).length).toBe(8);
  });
});
