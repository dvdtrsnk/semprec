import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import {
  createRelationPropertyWithClient,
  type CreateRelationPropertyInput,
} from "../chokePoint/relationPropertyOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";
import { MAILBOX_CLIENT_VIEW_TYPE, registerMailboxClientViewType } from "../views/mailboxClientViewType.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import {
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
} from "../mail/personLinkingActions.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID, THREADS_MODULE_ID } from "./emailModuleKeys.js";
import { COMPANIES_MODULE_ID, TASKS_MODULE_ID } from "./tenDatabaseKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

// Issue #145: every shipped catalog option `s` becomes `{ key: s }` — see seedTenDatabases.ts's
// copy of this helper for the full rationale.
function selectConfig(options: string[]): Record<string, unknown> {
  return { options: options.map((key) => ({ key })) };
}

interface PropSpec {
  key: string;
  name: string;
  type: PropertyType;
  owner?: PropertyOwner;
  config?: Record<string, unknown>;
}

async function createDb(
  client: PoolClient,
  name: string,
  ownerModuleId: string,
  ownerProjectItemId: string,
): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, {
    name,
    key: ownerModuleId,
    system: true,
    ownerModuleId,
    ownerProjectItemId,
  });
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, {
      databaseId,
      key: spec.key,
      name: spec.name,
      type: spec.type,
      owner: spec.owner,
      config: spec.config,
    });
  }
}

export async function createThreadsDatabase(
  client: PoolClient,
  ownerProjectItemId: string,
  projectsDatabaseId: string,
  companiesDatabaseId: string,
  computedKeyRegistry?: ComputedKeyRegistry,
): Promise<DatabaseRow> {
  const threads = await createDb(client, "Threads", THREADS_MODULE_ID, ownerProjectItemId);
  await createProps(client, threads.id, [{ key: "name", name: "Name", type: "title", owner: "system" }]);
  for (const target of [
    { key: "project", name: "Project", id: projectsDatabaseId },
    { key: "company", name: "Company", id: companiesDatabaseId },
  ]) {
    await createRelationPropertyWithClient(
      client,
      {
        sourceDatabaseId: threads.id,
        key: target.key,
        name: target.name,
        targetDatabaseId: target.id,
        cardinality: "many_to_many",
        owner: "user",
      },
      undefined,
      computedKeyRegistry,
    );
  }
  // Threads -> Tasks (issue #1612): Tasks is schema-locked, so the relation lives on Threads only. Threads is the
  // "one" side of `one_to_many`, so a task has at most one thread. User-owned: Semp links a task with `relation.put`.
  const tasks = await databasesStore.getDatabaseByModuleId(client, TASKS_MODULE_ID);
  if (!tasks) throw new Error("Tasks database is missing");
  await createRelationPropertyWithClient(
    client,
    {
      sourceDatabaseId: threads.id,
      key: "tasks",
      name: null,
      targetDatabaseId: tasks.id,
      cardinality: "one_to_many",
      owner: "user",
    },
    undefined,
    computedKeyRegistry,
  );
  return threads;
}

export interface EmailModuleResult {
  mailboxes: DatabaseRow;
  folders: DatabaseRow;
  emails: DatabaseRow;
  senderPeopleKey: string;
  recipientsPeopleKey: string;
  folderRelationKey: string;
  attachmentsRelationKey: string;
}

/**
 * Seeds Mailboxes/Folders/Emails (issue #26's sync core: only the tables/schema and the
 * deterministic People-linking wiring — drafts/sending belong to issue #95, the mailbox UI to
 * issues #96-98) as one system project, the same class as Books/Movies (issue #25). Must run after
 * `seedTenDatabasesInTransaction` (needs Projects/People/Files) and after `seedLibraryModule`
 * doesn't matter relative to this — order between the two module seeds is irrelevant, both
 * only depend on the ten databases.
 *
 * Also adds `People.emails` (issue #26 is this property's sole owner — issue #24's baseline
 * People schema does not include it) directly via `propertiesStore.createProperty` bypassing
 * the normal `schema_locked` rejection is not applicable here since we call the store
 * directly with a raw client, same as `seedSystem.ts`'s own "a code-level migration with
 * direct DB access is the one sanctioned way to write a system DB's schema" pattern — People
 * is unlocked just long enough for this one property, then re-locked.
 *
 * `emails` (free-form, one address per line) rather than a dedicated list-of-scalars
 * property type: no existing `PropertyType` holds a freeform list (`multi_select` requires a
 * fixed `config.options` enum, unsuitable for arbitrary addresses), and introducing a new
 * property type for exactly one field is more machinery than this issue's Task asks for —
 * `person_email_index` maintenance (personLinkingActions.ts) parses newline/comma-separated
 * values, the same shape a "one address per line" textarea naturally produces.
 */
export async function seedEmailModuleInTransaction(
  client: PoolClient,
  projectsDatabaseId: string,
  peopleDatabaseId: string,
  filesDatabaseId: string,
  computedKeyRegistry: ComputedKeyRegistry,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<EmailModuleResult> {
  registerMailboxClientViewType(viewTypeRegistry);
  const relate = (input: CreateRelationPropertyInput, context?: SystemRelationWriteContext) =>
    createRelationPropertyWithClient(client, input, context, computedKeyRegistry);

  const emailProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Email",
      systemActive: true,
      agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[MAILBOXES_MODULE_ID],
    },
  });

  const companies = await databasesStore.getDatabaseByModuleId(client, COMPANIES_MODULE_ID);
  if (!companies) throw new Error("Companies database is missing");
  const threads = await createThreadsDatabase(
    client,
    emailProject.id,
    projectsDatabaseId,
    companies.id,
    computedKeyRegistry,
  );
  const mailboxes = await createDb(client, "Mailboxes", MAILBOXES_MODULE_ID, emailProject.id);
  await createProps(client, mailboxes.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    {
      key: "provider",
      name: "Provider",
      type: "select",
      owner: "user",
      config: selectConfig(["gmail", "outlook", "icloud", "generic"]),
    },
    // Owned by the system since issue #1454: the OAuth connect flow (#1686) and the password connect
    // flow (#1736) record the verified address through mail/mailboxAddresses.ts, and a generic item
    // write (REST or agent) is refused with owner_violation.
    { key: "addresses", name: "Addresses", type: "longText", owner: "system" },
    // Overrides the sync worker's provider-derived default IMAP simultaneous-connection cap
    // (imapConnectionLimiter.ts) — unset by default, since most accounts should just take the
    // conservative per-provider default.
    { key: "connectionLimit", name: "Connection limit", type: "number", owner: "user" },
    {
      key: "syncStatus",
      name: "Sync status",
      type: "select",
      owner: "system",
      config: selectConfig(["ok", "error", "never", "needsReauthorization"]),
    },
  ]);

  const folders = await createDb(client, "Folders", FOLDERS_MODULE_ID, emailProject.id);
  await createProps(client, folders.id, [
    { key: "name", name: "Name", type: "title", owner: "system" },
    // 'folder' = the IMAP model (one message, one parent folder); 'label' = the Gmail model
    // (one message, many labels) — the mock's distinction the issue's spec names directly.
    { key: "behavior", name: "Behavior", type: "select", owner: "system", config: selectConfig(["folder", "label"]) },
    // A stable semantic key independent of how the folder happens to be named/localized.
    {
      key: "specialPurpose",
      name: "Special purpose",
      type: "select",
      owner: "system",
      config: selectConfig(["inbox", "sent", "junk", "trash", "drafts", "archive", "all", "none"]),
    },
    // The provider's own folder identifier (IMAP path, Gmail label id, Graph folder id) —
    // how `mail/folderDiscovery.ts` finds/creates the right Folder item for an incoming
    // message, scoped per-mailbox (two accounts can both have a folder whose providerId is
    // literally "INBOX").
    { key: "providerId", name: "Provider ID", type: "text", owner: "system" },
  ]);
  // Written by mail/folderDiscovery.ts as the Folders module's own process — system-owned so
  // no caller outside that discovery path can attach a Folder to a different Mailbox.
  // `property_id_a` is Mailboxes.folders (the "one" side, per issue #82's cardinality
  // contract: one mailbox may have many folder edges), with Folders.mailbox as the inverse —
  // not the other way around, since a folder's own `mailbox` field is single-valued and must
  // be the side the enforced `one_to_many` constraint lands on.
  await relate(
    {
      sourceDatabaseId: mailboxes.id,
      key: "folders",
      name: "Folders",
      targetDatabaseId: folders.id,
      cardinality: "one_to_many",
      owner: "system",
      ownerProcess: FOLDERS_MODULE_ID,
      // Also system-owned by the same process: otherwise a caller could write this edge
      // through the inverse property's default owner:'user', bypassing the ownership the
      // source side declares.
      inverse: { key: "mailbox", name: "Mailbox", owner: "system", ownerProcess: FOLDERS_MODULE_ID },
    },
    { ownerProcess: FOLDERS_MODULE_ID },
  );

  const emails = await createDb(client, "Emails", EMAILS_MODULE_ID, emailProject.id);
  await createProps(client, emails.id, [
    { key: "name", name: "Subject", type: "title", owner: "system" },
    // Derived display text (issue #26) — the structured source of truth is
    // `mail_message_meta.envelope`, not this column.
    { key: "sender", name: "Sender", type: "text", owner: "system" },
    { key: "recipients", name: "Recipients", type: "text", owner: "system" },
    { key: "body", name: "Body", type: "longText", owner: "system" },
    { key: "date", name: "Date", type: "date", owner: "system", config: { includeTime: true } },
    // Read and flag state as ordinary generic properties, mirroring the canonical IMAP
    // `\\Seen`/`\\Flagged` flags (mail/messageFlags.ts): the sync worker seeds them from the
    // flags a message arrives with, and the mailbox's triage actions (issue #97) set them
    // afterwards. owner:'user' — unlike every other Emails field, these two are user state,
    // written through the ordinary generic item-update path rather than by a sync-only writer.
    { key: "read", name: "Read", type: "checkbox", owner: "user" },
    { key: "flagged", name: "Flagged", type: "checkbox", owner: "user" },
  ]);
  // Every Emails relation below is system-owned by the Emails module process — written only
  // by the sync/ingest/send/attachments/person-linking writers, matching the "every field ...
  // is owner: 'system'" contract above for Emails' plain properties.
  const emailsContext: SystemRelationWriteContext = { ownerProcess: EMAILS_MODULE_ID };
  const folderRelation = await relate(
    {
      sourceDatabaseId: emails.id,
      key: "folder",
      name: "Folder",
      targetDatabaseId: folders.id,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: EMAILS_MODULE_ID,
      // Also system-owned by the same process: otherwise a caller could write this edge
      // through the inverse property's default owner:'user', bypassing the ownership the
      // source side declares.
      inverse: { key: "emails", name: "Emails", owner: "system", ownerProcess: EMAILS_MODULE_ID },
    },
    emailsContext,
  );
  // One-directional: Files' schema is already locked by the time this runs (issue #24),
  // same reason Movies -> People (issue #25) carries no inverse property on People either.
  // `one_to_many` (issue #82): property_id_a/item_a (the Email) is the "one" side that may
  // have many item_b edges — one email, many attachment files — while each Files item
  // (item_b), freshly created per attachment, is used by exactly one email.
  const attachmentsRelation = await relate(
    {
      sourceDatabaseId: emails.id,
      key: "attachments",
      name: "Attachments",
      targetDatabaseId: filesDatabaseId,
      cardinality: "one_to_many",
      owner: "system",
      ownerProcess: EMAILS_MODULE_ID,
    },
    emailsContext,
  );
  // People's schema is likewise already locked — both People-facing relations below are
  // one-directional for the same reason.
  // A person may send many emails (issue #1457), so this is many_to_many. Cardinality does not
  // keep "one message, one sender"; today mail/personLinkingActions.ts is the only writer of this
  // edge. Populated installs are switched by mail/emailsSenderPeopleCardinalityCutoverMigration.ts.
  await relate(
    {
      sourceDatabaseId: emails.id,
      key: "senderPeople",
      name: "Sender",
      targetDatabaseId: peopleDatabaseId,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: EMAILS_MODULE_ID,
    },
    emailsContext,
  );
  await relate(
    {
      sourceDatabaseId: emails.id,
      key: "recipientsPeople",
      name: "Recipients",
      targetDatabaseId: peopleDatabaseId,
      cardinality: "many_to_many",
      owner: "system",
      ownerProcess: EMAILS_MODULE_ID,
    },
    emailsContext,
  );

  // The mailbox's default view, resolved by the client through the registered view type
  // (clientComponent 'mailboxClient') the same way Journal resolves its temporal switcher.
  await viewsStore.createView(
    client,
    {
      databaseId: emails.id,
      type: MAILBOX_CLIENT_VIEW_TYPE,
      name: "Mailbox",
      isDefault: true,
      ownerModuleId: EMAILS_MODULE_ID,
      config: {
        foldersDatabaseId: folders.id,
        folderRelationKey: folderRelation.property.key,
        readPropertyKey: "read",
        flaggedPropertyKey: "flagged",
        mailboxesDatabaseId: mailboxes.id,
        mailboxRelationKey: "mailbox",
        sort: [{ property: "date", direction: "desc" }],
      },
    },
    viewTypeRegistry,
  );

  const lockedDatabases = await client.query(`UPDATE databases SET schema_locked = true WHERE id = ANY($1::uuid[])`, [
    [mailboxes.id, folders.id, emails.id, threads.id],
  ]);
  if (lockedDatabases.rowCount !== 4) throw new Error("Expected four mail databases to be locked");

  // People.emails (issue #26 is its sole owner) — direct store call against the raw client,
  // the same "code-level migration with direct DB access" exception seedSystem.ts documents
  // for a system DB's schema, bypassing the schema_locked rejection that would otherwise
  // reject this on the already-locked People database. Idempotent via the properties table's
  // own UNIQUE(database_id, key).
  await client.query(
    `INSERT INTO properties (database_id, key, name, type, config, owner)
     VALUES ($1, 'emails', 'Emails', 'longText', '{}'::jsonb, 'user')
     ON CONFLICT (database_id, key) DO NOTHING`,
    [peopleDatabaseId],
  );

  await createHeartbeat(client, {
    projectItemId: emailProject.id,
    name: "Reindex People.emails",
    rule: { kind: "onItemEvent", databaseId: peopleDatabaseId, event: "create" },
    actionId: MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
    actionConfig: { peopleDatabaseId },
  });
  await createHeartbeat(client, {
    projectItemId: emailProject.id,
    name: "Reindex People.emails (update)",
    rule: { kind: "onItemEvent", databaseId: peopleDatabaseId, event: "update" },
    actionId: MAIL_REINDEX_PERSON_EMAILS_ACTION_ID,
    actionConfig: { peopleDatabaseId },
  });
  await createHeartbeat(client, {
    projectItemId: emailProject.id,
    name: "Link Emails to People",
    rule: { kind: "onItemEvent", databaseId: emails.id, event: "create" },
    actionId: MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
    actionConfig: {
      emailsDatabaseId: emails.id,
      senderPeopleKey: "senderPeople",
      recipientsPeopleKey: "recipientsPeople",
    },
  });
  // issue #99: a new Inbox message should nudge the owning project's agent — dispatched through
  // the same core.agentRun action any other project heartbeat uses (no mail-specific scheduler),
  // gated by itemRelationFilter.ts so junk/trash-only mail (and reconciliation of an
  // already-known message, which never re-enters createItemWithClient — see mail/ingest.ts)
  // never triggers it.
  await createHeartbeat(client, {
    projectItemId: emailProject.id,
    name: "newEmail",
    rule: { kind: "onItemEvent", databaseId: emails.id, event: "create" },
    actionId: CORE_AGENT_RUN_ACTION_ID,
    actionConfig: {
      task: "A new message arrived in the Inbox.",
      senderKnownFilter: {},
      itemRelationFilter: {
        relationPropertyId: folderRelation.property.id,
        property: "specialPurpose",
        include: ["inbox"],
        exclude: ["junk", "trash"],
      },
    },
  });

  return {
    mailboxes,
    folders,
    emails,
    senderPeopleKey: "senderPeople",
    recipientsPeopleKey: "recipientsPeople",
    folderRelationKey: folderRelation.property.key,
    attachmentsRelationKey: attachmentsRelation.property.key,
  };
}
