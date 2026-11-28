import { createRelationPropertyWithClient } from "../chokePoint/relationPropertyWrites.js";
import type { Pool, PoolClient } from "pg";
import { ModuleRegistry } from "@alldots/module-registry";
import { withTransaction } from "../db/pool.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { DRIFT_CHECK_ACTION_ID } from "../manifest/driftCheck.js";
import { MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID } from "../manifest/moduleRegistryDriftCheck.js";
import { DEFAULT_TIMEZONE, SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { registerTemporalSwitcherViewType } from "../views/temporalSwitcherViewType.js";
import { registerLibraryGridViewType } from "../views/libraryGridViewType.js";
import { registerMailboxClientViewType } from "../views/mailboxClientViewType.js";
import { registerJournalInboxViewType } from "../views/journalInboxViewType.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../inbox/journalInboxCompute.js";
import { JOURNAL_SUMMARY_COMPUTED_KEY } from "../journal/journalSummary.js";
import {
  TRANSCRIPTION_CREATE_COMPUTED_KEY,
  TRANSCRIPTION_PREPARE_COMPUTED_KEY,
  TRANSCRIPTION_DIARIZE_COMPUTED_KEY,
  TRANSCRIPTION_ASR_COMPUTED_KEY,
  TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY,
  TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
  TRANSCRIPT_LANGUAGE_COMPUTED_KEY,
  TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY,
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY,
  TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY,
} from "../transcription/transcriptionComputedKeys.js";
import {
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
  TRANSCRIPTION_REQUEUE_HEARTBEAT,
  TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
} from "../transcription/transcriptionActions.js";
import { seedTenDatabasesInTransaction } from "./seedTenDatabases.js";
import { TASKS_DAY_ROLLOVER_ACTION_ID, TASKS_DAY_ROLLOVER_HEARTBEAT } from "../tasks/tasksDayRolloverAction.js";
import { ensureJournalWeeklyCleanupHeartbeat } from "../journal/journalWeeklyCleanupAction.js";
import { seedLibraryModuleInTransaction } from "./seedLibraryModule.js";
import { seedEmailModuleInTransaction } from "./seedEmailModule.js";
import { seedInboxPipelineInTransaction } from "./seedInboxPipeline.js";
import { INBOX_MODULE_ID } from "./inboxPipelineKeys.js";
import { SEEDED_DEFAULT_INBOX_TYPES_KEY, SEEDED_DEFAULT_INBOX_TYPES_NAME } from "../inbox/defaultInboxTypes.js";
import { seedMcpModuleInTransaction } from "./seedMcpModule.js";
import { seedCalendarsInTransaction } from "./seedCalendars.js";
import { seedInvitationsDatabaseInTransaction } from "./seedInvitationsDatabase.js";
import { seedRecipesModuleInTransaction } from "./seedRecipesModule.js";
import { seedSleepModuleInTransaction } from "./seedSleepModule.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

export { PROJECTS_MODULE_ID } from "./tenDatabaseKeys.js";

// Serializes concurrent seeds of one tenant; distinct from auth's SETUP_ADVISORY_LOCK_KEY (2330n). The
// two-key form (key, hashtext(tenant id)) keeps different tenants from waiting on each other.
const SEED_ADVISORY_LOCK_KEY = 2331;

async function requireTenantId(client: PoolClient, caller: string): Promise<string> {
  const tenantRows = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
  const tenantId = tenantRows.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new Error(`${caller}: no tenant resolved; run it inside a tenant scope when several tenants exist`);
  }
  return tenantId;
}

async function admitTenant(client: PoolClient, tenantId: string, caller: string): Promise<void> {
  const tenantStatus = await client.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1 FOR SHARE", [
    tenantId,
  ]);
  const status = tenantStatus.rows[0]?.status;
  if (status === undefined || status === "deleting") {
    throw new Error(`${caller}: tenant ${tenantId} is ${status ?? "missing"}; refusing to seed it`);
  }
}

/** Refuses a missing tenant or one that is `deleting`, reading the row `FOR SHARE` so a deletion waits. */
export async function admitTenantInTransaction(client: PoolClient, caller: string): Promise<string> {
  const tenantId = await requireTenantId(client, caller);
  await admitTenant(client, tenantId, caller);
  return tenantId;
}

/** Takes the per-tenant seed lock `(2331, hashtext(tenant id))`, then admits the tenant (seedSystem's order). */
async function lockTenantSeedInTransaction(client: PoolClient, caller: string): Promise<string> {
  const tenantId = await requireTenantId(client, caller);
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SEED_ADVISORY_LOCK_KEY, tenantId]);
  await admitTenant(client, tenantId, caller);
  return tenantId;
}

/**
 * Seeds every system database of the caller's tenant through the raw stores (the choke point refuses
 * locked/system databases). Idempotent and concurrency-safe under the per-tenant advisory lock: exactly one
 * of two concurrent calls resolves `"created"`.
 *
 * A server should pass its shared registries so the types and keys registered here reach its choke point.
 */
export async function seedSystem(
  pool: Pool,
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
): Promise<"created" | "already-seeded"> {
  const moduleRegistry = await prepareSeedRegistries(viewTypeRegistry, computedKeyRegistry);
  return withTransaction(pool, (client) =>
    seedSystemInTransaction(client, viewTypeRegistry, computedKeyRegistry, moduleRegistry),
  );
}

async function prepareSeedRegistries(
  viewTypeRegistry: ViewTypeRegistry,
  computedKeyRegistry: ComputedKeyRegistry,
): Promise<ModuleRegistry> {
  // Registered before the idempotency guard: the registries are per-process, so every startup needs these
  // even though the one-time seed is skipped. Registration is idempotent.
  registerTemporalSwitcherViewType(viewTypeRegistry);
  registerLibraryGridViewType(viewTypeRegistry);
  registerMailboxClientViewType(viewTypeRegistry);
  registerJournalInboxViewType(viewTypeRegistry);
  computedKeyRegistry.add(JOURNAL_INBOX_COMPUTED_KEY);
  computedKeyRegistry.add(JOURNAL_SUMMARY_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPT_DURATION_SECONDS_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPT_FINALIZED_AT_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPT_SEGMENTS_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPTION_CREATE_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPTION_PREPARE_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPTION_DIARIZE_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPTION_ASR_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPT_SUMMARY_BY_INSTRUCTION_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPT_LANGUAGE_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPTION_SUGGEST_SPEAKERS_COMPUTED_KEY);
  computedKeyRegistry.add(TRANSCRIPTION_EVENT_RECOMMENDATION_COMPUTED_KEY);

  // The systemDatabases manifest describes the core databases this seed creates;
  // `seedTenDatabasesInTransaction` reads its `defaultViewType` projection.
  const moduleRegistry = new ModuleRegistry(() => new Set(["systemDatabases"]));
  await moduleRegistry.loadModule(new URL("./systemDatabasesModuleManifest.js", import.meta.url).href);
  return moduleRegistry;
}

async function seedSystemInTransaction(
  client: PoolClient,
  viewTypeRegistry: ViewTypeRegistry,
  computedKeyRegistry: ComputedKeyRegistry,
  moduleRegistry: ModuleRegistry,
): Promise<"created" | "already-seeded"> {
  // Before the guard, so a concurrent seed waits here and then sees this one's rows.
  await lockTenantSeedInTransaction(client, "seedSystem");
  const existingSettings = await client.query(`SELECT id FROM databases WHERE owner_module_id = $1 AND system`, [
    SYSTEM_SETTINGS_MODULE_ID,
  ]);
  if ((existingSettings.rowCount ?? 0) > 0) return "already-seeded";

  const tenDatabases = await seedTenDatabasesInTransaction(
    client,
    viewTypeRegistry,
    computedKeyRegistry,
    moduleRegistry,
  );
  const projectsDb = tenDatabases.projects;

  const alldotsProject = await itemsStore.insertItem(client, {
    databaseId: projectsDb.id,
    properties: {
      name: "Alldots",
      systemActive: true,
      agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[SYSTEM_SETTINGS_MODULE_ID],
    },
  });

  // Created unlocked so propertiesStore.createProperty (which enforces schema_locked) accepts the writes
  // below; locked with a raw UPDATE afterwards.
  const settingsDb = await databasesStore.createDatabase(client, {
    name: "System settings",
    system: true,
    ownerModuleId: SYSTEM_SETTINGS_MODULE_ID,
    ownerProjectItemId: alldotsProject.id,
  });
  await propertiesStore.createProperty(client, {
    databaseId: settingsDb.id,
    key: "name",
    name: "Name",
    type: "text",
    locked: true,
    owner: "user",
  });
  await propertiesStore.createProperty(client, {
    databaseId: settingsDb.id,
    key: "timezone",
    name: "Timezone",
    type: "text",
    locked: true,
    owner: "user",
  });

  // Defaults of the seeded Inbox item types; none yet.
  await propertiesStore.createProperty(client, {
    databaseId: settingsDb.id,
    key: SEEDED_DEFAULT_INBOX_TYPES_KEY,
    name: SEEDED_DEFAULT_INBOX_TYPES_NAME,
    type: "json",
    owner: "system",
    ownerProcess: INBOX_MODULE_ID,
  });

  await itemsStore.insertItem(client, {
    databaseId: settingsDb.id,
    properties: {
      name: "Semp",
      timezone: DEFAULT_TIMEZONE,
      [SEEDED_DEFAULT_INBOX_TYPES_KEY]: [],
    },
  });

  const people = await databasesStore.getDatabaseByModuleId(client, "people");
  if (!people) throw new Error("People database has not been seeded");
  await createRelationPropertyWithClient(client, {
    sourceDatabaseId: settingsDb.id,
    key: "selfPerson",
    name: null,
    targetDatabaseId: people.id,
    cardinality: "one_to_one",
    owner: "user",
    locked: true,
  });

  await client.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [settingsDb.id]);

  // Daily manifest <-> text/owner_process drift check for the supervisor's project. Needs settingsDb:
  // next_fire_at reads the system timezone.
  await createHeartbeat(client, {
    projectItemId: alldotsProject.id,
    name: "Manifest drift check",
    rule: { kind: "dailyTime", at: "03:00" },
    actionId: DRIFT_CHECK_ACTION_ID,
  });

  // Live mechanical drift check: catches manual DB edits made after startup, which load-time validation
  // cannot see. Offset five minutes from the check above.
  await createHeartbeat(client, {
    projectItemId: alldotsProject.id,
    name: "Module registry drift check",
    rule: { kind: "dailyTime", at: "03:05" },
    actionId: MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID,
  });

  // Needs Projects/People and the system timezone.
  await seedLibraryModuleInTransaction(
    client,
    projectsDb.id,
    tenDatabases.people.id,
    viewTypeRegistry,
    computedKeyRegistry,
  );

  // Order relative to the library module does not matter.
  const emailModuleResult = await seedEmailModuleInTransaction(
    client,
    projectsDb.id,
    tenDatabases.people.id,
    tenDatabases.files.id,
    computedKeyRegistry,
    viewTypeRegistry,
  );

  // Files transcription trigger: fires on every Files item creation but only transcribes a standalone
  // `audio/*` file (see transcriptionActions.ts); needs the attachments property created just above.
  const attachmentsProperty = await propertiesStore.getPropertyByKey(
    client,
    emailModuleResult.emails.id,
    emailModuleResult.attachmentsRelationKey,
  );
  if (!attachmentsProperty) {
    throw new Error("Emails.attachments property not found after seedEmailModuleInTransaction");
  }
  // The trigger also skips a file attached to an Event, so it needs the Files.events property id.
  const eventsProperty = await propertiesStore.getPropertyByKey(client, tenDatabases.files.id, "events");
  if (!eventsProperty) {
    throw new Error("Files.events property not found after seedTenDatabasesInTransaction");
  }
  await createHeartbeat(client, {
    projectItemId: alldotsProject.id,
    name: "Files transcription trigger",
    rule: { kind: "onItemEvent", databaseId: tenDatabases.files.id, event: "create" },
    actionId: FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
    actionConfig: {
      filesDatabaseId: tenDatabases.files.id,
      attachmentsRelationPropertyId: attachmentsProperty.id,
      eventsRelationPropertyId: eventsProperty.id,
    },
  });
  // Daily: puts every failed Transcriptions row back into the pipeline as a fresh batch.
  await createHeartbeat(client, {
    projectItemId: alldotsProject.id,
    ...TRANSCRIPTION_REQUEUE_HEARTBEAT,
    actionId: TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID,
    actionConfig: { transcriptsDatabaseId: tenDatabases.transcripts.id },
  });
  // Midnight: moves unfinished one-off tasks to the new day.
  await createHeartbeat(client, {
    projectItemId: alldotsProject.id,
    ...TASKS_DAY_ROLLOVER_HEARTBEAT,
    actionId: TASKS_DAY_ROLLOVER_ACTION_ID,
    actionConfig: { tasksDatabaseId: tenDatabases.tasks.id },
  });
  // Sunday evening: asks the assistant to tidy the Journal.
  await ensureJournalWeeklyCleanupHeartbeat(client, alldotsProject.id);

  // Needs Journal, Transcripts, Threads and the Alldots project item.
  await seedInboxPipelineInTransaction(
    client,
    tenDatabases.journal.id,
    tenDatabases.transcripts.id,
    alldotsProject.id,
    computedKeyRegistry,
    viewTypeRegistry,
  );

  // Non-secret MCP connection metadata only.
  await seedMcpModuleInTransaction(client, projectsDb.id);

  // Edits the Events database created above.
  const { calendars } = await seedCalendarsInTransaction(client, projectsDb.id, tenDatabases.events.id);

  // After Calendars (whose project owns it) and the email module (Emails, Mailboxes).
  await seedInvitationsDatabaseInTransaction(client, calendars);

  await seedRecipesModuleInTransaction(client, projectsDb.id, viewTypeRegistry);

  // Three databases, one settings item, two default plans.
  await seedSleepModuleInTransaction(client, projectsDb.id, viewTypeRegistry);
  return "created";
}
