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
import { COMPANIES_MODULE_ID, FILES_MODULE_ID, TASKS_MODULE_ID } from "./tenDatabaseKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

// Every catalog option `s` becomes `{ key: s }`; see the copy in seedTenDatabases.ts.
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
  // Threads -> Tasks: Tasks is schema-locked, so the relation lives on Threads only. Threads is the "one"
  // side, so a task has at most one thread. User-owned: Semp links a task with `relation.put`.
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
  // Threads -> Files (attachments): one-directional (Files is locked), one thread per file, system-owned by `emails`.
  const files = await databasesStore.getDatabaseByModuleId(client, FILES_MODULE_ID);
  if (!files) throw new Error("Files database is missing");
  await createRelationPropertyWithClient(
    client,
    {
      sourceDatabaseId: threads.id,
      key: "attachments",
      name: null,
      targetDatabaseId: files.id,
      cardinality: "one_to_many",
      owner: "system",
      ownerProcess: EMAILS_MODULE_ID,
    },
    { ownerProcess: EMAILS_MODULE_ID },
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
 * Seeds Mailboxes/Folders/Emails as one system project, after the ten databases. Also adds `People.emails`
 * (one address per line in a longText; no property type holds a free list), briefly unlocking People.
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
    // System-owned: the OAuth and password connect flows record the verified address through
    // mail/mailboxAddresses.ts; a generic item write is refused with owner_violation.
    { key: "addresses", name: "Addresses", type: "longText", owner: "system" },
    // Overrides the provider-derived IMAP connection cap (imapConnectionLimiter.ts); unset by default.
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
    // 'folder': IMAP model (one parent folder); 'label': Gmail model (many labels).
    { key: "behavior", name: "Behavior", type: "select", owner: "system", config: selectConfig(["folder", "label"]) },
    // Stable semantic key independent of the folder's name or localization.
    {
      key: "specialPurpose",
      name: "Special purpose",
      type: "select",
      owner: "system",
      config: selectConfig(["inbox", "sent", "junk", "trash", "drafts", "archive", "all", "none"]),
    },
    // The provider's folder identifier (IMAP path, Gmail label id, Graph folder id), scoped per mailbox,
    // since two accounts can both have "INBOX".
    { key: "providerId", name: "Provider ID", type: "text", owner: "system" },
  ]);
  // Written by folderDiscovery.ts; Mailboxes.folders is property A so `one_to_many` binds the single-valued side.
  await relate(
    {
      sourceDatabaseId: mailboxes.id,
      key: "folders",
      name: "Folders",
      targetDatabaseId: folders.id,
      cardinality: "one_to_many",
      owner: "system",
      ownerProcess: FOLDERS_MODULE_ID,
      // The inverse is system-owned too, or a caller could write the edge through its default owner:'user'.
      inverse: { key: "mailbox", name: "Mailbox", owner: "system", ownerProcess: FOLDERS_MODULE_ID },
    },
    { ownerProcess: FOLDERS_MODULE_ID },
  );

  const emails = await createDb(client, "Emails", EMAILS_MODULE_ID, emailProject.id);
  await createProps(client, emails.id, [
    { key: "name", name: "Subject", type: "title", owner: "system" },
    // Derived display text; the source of truth is `mail_message_meta.envelope`.
    { key: "sender", name: "Sender", type: "text", owner: "system" },
    { key: "recipients", name: "Recipients", type: "text", owner: "system" },
    { key: "body", name: "Body", type: "longText", owner: "system" },
    { key: "date", name: "Date", type: "date", owner: "system", config: { includeTime: true } },
    // Mirror IMAP `\\Seen`/`\\Flagged` (mail/messageFlags.ts): seeded by sync, then set by triage actions.
    // Unlike every other Emails field these are user state, written through the generic item-update path.
    { key: "read", name: "Read", type: "checkbox", owner: "user" },
    { key: "flagged", name: "Flagged", type: "checkbox", owner: "user" },
  ]);
  // Every Emails relation is system-owned by the Emails process (sync, ingest, send, attachments and
  // person-linking writers), like its plain properties.
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
      // The inverse is system-owned too, or a caller could write the edge through its default owner:'user'.
      inverse: { key: "emails", name: "Emails", owner: "system", ownerProcess: EMAILS_MODULE_ID },
    },
    emailsContext,
  );
  // One-directional because Files is already locked. `one_to_many`: one email, many attachment files,
  // each Files item used by exactly one email.
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
  // People is locked too, so both People relations below are one-directional. A person may send many
  // emails, so many_to_many; mail/personLinkingActions.ts is the only writer of this edge.
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

  // Resolved by the client through the registered view type (clientComponent 'mailboxClient').
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

  // People.emails via the raw client, bypassing the schema lock on People (the direct-DB seed exception).
  // Idempotent through the properties table's UNIQUE(database_id, key).
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
  // A new Inbox message nudges the project's agent via core.agentRun, gated by itemRelationFilter (no
  // junk/trash), `runProject` and `answerExpectedFilter`.
  await createHeartbeat(client, {
    projectItemId: emailProject.id,
    name: "newEmail",
    rule: { kind: "onItemEvent", databaseId: emails.id, event: "create" },
    actionId: CORE_AGENT_RUN_ACTION_ID,
    actionConfig: {
      task: "A new message arrived in the Inbox.",
      senderKnownFilter: {},
      answerExpectedFilter: {},
      runProject: { resolver: "mailThreadProject" },
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
