import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createRelationPropertyWithClient, type CreateRelationPropertyInput } from "../chokePoint/chokePoint.js";
import type { ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, MAIL_REINDEX_PERSON_EMAILS_ACTION_ID } from "../mail/personLinkingActions.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "./emailModuleKeys.js";

function selectConfig(options: string[]): Record<string, unknown> {
  return { options };
}

interface PropSpec {
  key: string;
  name: string;
  type: PropertyType;
  owner?: PropertyOwner;
  config?: Record<string, unknown>;
}

async function createDb(client: PoolClient, name: string, ownerModuleId: string, ownerProjectItemId: string): Promise<DatabaseRow> {
  return databasesStore.createDatabase(client, { name, system: true, ownerModuleId, ownerProjectItemId });
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, { databaseId, key: spec.key, name: spec.name, type: spec.type, owner: spec.owner, config: spec.config });
  }
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
 * deterministic People-linking wiring — mailbox UI, sending, drafts belong to issue #27) as
 * one system project, the same class as Books/Movies (issue #25). Must run after
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
): Promise<EmailModuleResult> {
  const relate = (input: CreateRelationPropertyInput) => createRelationPropertyWithClient(client, input, computedKeyRegistry);

  const emailProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Email",
      systemActive: true,
      agents:
        "Purpose: keep synced mailboxes/folders/messages consistent and link messages to People deterministically.\n" +
        "Allowed: read Mailboxes/Folders/Emails via the generic list/get endpoints.\n" +
        "Not allowed: write any Mailboxes/Folders/Emails property directly — every field is owner: 'system', written only by the sync worker, which mirrors the real mailbox (source of truth stays the provider's server, not this DB).\n" +
        "General instructions: this project has no agent-facing write surface; it exists to host the sync worker's heartbeats.",
    },
  });

  const mailboxes = await createDb(client, "Mailboxes", MAILBOXES_MODULE_ID, emailProject.id);
  await createProps(client, mailboxes.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "provider", name: "Provider", type: "select", owner: "user", config: selectConfig(["gmail", "outlook", "icloud", "generic"]) },
    { key: "addresses", name: "Addresses", type: "longText", owner: "user" },
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
  await relate({ databaseId: folders.id, key: "mailbox", name: "Mailbox", targetDatabaseId: mailboxes.id, cardinality: "one_to_many", inverse: { key: "folders", name: "Folders" } });

  const emails = await createDb(client, "Emails", EMAILS_MODULE_ID, emailProject.id);
  await createProps(client, emails.id, [
    { key: "name", name: "Subject", type: "title", owner: "system" },
    // Derived display text (issue #26) — the structured source of truth is
    // `mail_message_meta.envelope`, not this column.
    { key: "sender", name: "Sender", type: "text", owner: "system" },
    { key: "recipients", name: "Recipients", type: "text", owner: "system" },
    { key: "body", name: "Body", type: "longText", owner: "system" },
    { key: "date", name: "Date", type: "date", owner: "system", config: { includeTime: true } },
  ]);
  const folderRelation = await relate({
    databaseId: emails.id,
    key: "folder",
    name: "Folder",
    targetDatabaseId: folders.id,
    cardinality: "many_to_many",
    inverse: { key: "emails", name: "Emails" },
  });
  // One-directional: Files' schema is already locked by the time this runs (issue #24),
  // same reason Movies -> People (issue #25) carries no inverse property on People either.
  const attachmentsRelation = await relate({ databaseId: emails.id, key: "attachments", name: "Attachments", targetDatabaseId: filesDatabaseId, cardinality: "one_to_many" });
  // People's schema is likewise already locked — both People-facing relations below are
  // one-directional for the same reason.
  await relate({ databaseId: emails.id, key: "senderPeople", name: "Sender", targetDatabaseId: peopleDatabaseId, cardinality: "one_to_many" });
  await relate({ databaseId: emails.id, key: "recipientsPeople", name: "Recipients", targetDatabaseId: peopleDatabaseId, cardinality: "many_to_many" });

  await client.query(`UPDATE databases SET schema_locked = true WHERE id = ANY($1::uuid[])`, [[mailboxes.id, folders.id, emails.id]]);

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
    actionConfig: { emailsDatabaseId: emails.id, senderPeopleKey: "senderPeople", recipientsPeopleKey: "recipientsPeople" },
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
