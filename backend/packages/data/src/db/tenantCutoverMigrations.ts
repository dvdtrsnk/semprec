import { runAreasUnplannedCutoverMigration } from "../seed/areasUnplannedCutoverMigration.js";
import { runProjectsCompletedAtCutoverMigration } from "../seed/projectsCompletedAtCutoverMigration.js";
import { runSelectOptionColorsCutoverMigration } from "../seed/selectOptionColorsCutoverMigration.js";
import { runRatingFilterPresetsCutoverMigration } from "../seed/ratingFilterPresetsCutoverMigration.js";
import { runSelectOptionOrderCutoverMigration } from "../seed/selectOptionOrderCutoverMigration.js";
import { runThreadsDatabaseCutoverMigration } from "../mail/threadsDatabaseCutoverMigration.js";
import { runThreadTasksCutoverMigration } from "../mail/threadTasksCutoverMigration.js";
import { runProjectsPinnedOrderCutoverMigration } from "../seed/projectsPinnedOrderCutoverMigration.js";
import { runAreasPropertiesCutoverMigration } from "../seed/areasPropertiesCutoverMigration.js";
import { runLibraryHeartbeatConfigCutoverMigration } from "../library/libraryHeartbeatConfigCutoverMigration.js";
import { runLibraryBooksYearIsbnCutoverMigration } from "../library/libraryBooksYearIsbnCutoverMigration.js";
import { runSelfPersonCutoverMigration } from "../tenancy/selfPersonCutoverMigration.js";
import { runTranscriptionLanguageCodeCutoverMigration } from "../transcription/transcriptionLanguageCodeCutoverMigration.js";
import { runTranscriptDurationBackfillCutoverMigration } from "../transcription/transcriptDurationBackfillCutoverMigration.js";
import { runPropertyDefaultsCutoverMigration } from "../seed/propertyDefaultsCutoverMigration.js";
import type { Pool } from "pg";
import { runItemsCreatedAtBackfillCutoverMigration } from "./itemsCreatedAtBackfillCutoverMigration.js";
import { runEventsAreaCutoverMigration } from "../events/eventsAreaCutoverMigration.js";
import { runEventsFilesRelationCutoverMigration } from "../blobs/eventsFilesRelationCutoverMigration.js";
import { assertRowSecurityActive, forEachMaintainedTenant } from "../tenancy/provisionTenant.js";
import { runFilesTypeOptionsCutoverMigration } from "../blobs/filesTypeOptionsCutoverMigration.js";
import { runTranscriptsCatalogCutoverMigration } from "../transcription/transcriptsCatalogCutoverMigration.js";
import { runEventTranscriptCardinalityCutoverMigration } from "../transcription/eventTranscriptCardinalityCutoverMigration.js";
import { runTranscriptionRequeueHeartbeatCutoverMigration } from "../transcription/transcriptionRequeueHeartbeatCutoverMigration.js";
import { runEventsCalendarPropertiesCutoverMigration } from "../calendar/eventsCalendarPropertiesCutoverMigration.js";
import { runEventsIcalIdentityCutoverMigration } from "../calendar/eventsIcalIdentityCutoverMigration.js";
import { runCalendarsCutoverMigration } from "../calendar/calendarsCutoverMigration.js";
import { runProjectAgentGuidanceCutoverMigration } from "../projectAgentGuidance/projectAgentGuidanceCutoverMigration.js";
import { runProcessingProposalsCardStateCutoverMigration } from "../inbox/processingProposalsCardStateCutoverMigration.js";
import { runMailboxAddressesOwnerCutoverMigration } from "../mail/mailboxAddressesOwnerCutoverMigration.js";
import { runEmailsSenderPeopleCardinalityCutoverMigration } from "../mail/emailsSenderPeopleCardinalityCutoverMigration.js";
import { runMailDraftsAndSentReadBackfill } from "../mail/mailDraftsAndSentReadBackfill.js";
import { runMailDatabaseKeysCutoverMigration } from "../mail/mailDatabaseKeysCutoverMigration.js";
import { runPeoplePhonesCutoverMigration } from "../seed/peoplePhonesCutoverMigration.js";
import { runPeopleLastContactCutoverMigration } from "../people/peopleLastContactCutoverMigration.js";
import { runTasksSchemaCutoverMigration } from "../tasks/tasksSchemaCutoverMigration.js";
import { runTasksSourceEventsCutoverMigration } from "../tasks/tasksSourceEventsCutoverMigration.js";
import { runTaskRecurrenceSeriesCutoverMigration } from "../tasks/taskRecurrenceSeriesCutoverMigration.js";
import { runJournalProjectCutoverMigration } from "../journal/journalProjectCutoverMigration.js";
import { runJournalEventsCutoverMigration } from "../journal/journalEventsCutoverMigration.js";
import { runPeopleRelationshipOptionsCutoverMigration } from "../seed/peopleRelationshipOptionsCutoverMigration.js";
import { runNewEmailSenderFilterCutoverMigration } from "../mail/newEmailSenderFilterCutoverMigration.js";
import { runAreaNoteCutoverMigration } from "../docs/areaNoteCutoverMigration.js";

/**
 * Runs the data-driven post-migration cutovers — the ones that read and write tenant rows — once
 * for every maintained tenant, each inside that tenant's own scope. `pool` must connect as a role
 * row-level security applies to (`createPool(url, { role: "semprec_data" })`); an owner or
 * superuser pool is refused before anything is written, because it would see every tenant's rows.
 * One tenant's failure does not stop the others; afterwards one `AggregateError` names the failed
 * tenants. See `docs/adr/2026-09-10-app-code-post-migration-steps.md`.
 */
export async function runTenantCutoverMigrations(pool: Pool): Promise<void> {
  await assertRowSecurityActive(pool);
  await forEachMaintainedTenant(pool, async () => {
    // First (issue #1594): a later step that writes an old row moves its `updated_at` past the ALTER's
    // `created_at`, after which the backfill no longer matches that row. The Tasks data migration planned
    // in #1657 rewrites `updated_at` and is ordered after this backfill for the same reason.
    await runItemsCreatedAtBackfillCutoverMigration(pool);
    await runMailDatabaseKeysCutoverMigration(pool);
    await runThreadsDatabaseCutoverMigration(pool);
    await runThreadTasksCutoverMigration(pool);
    await runPropertyDefaultsCutoverMigration(pool);
    await runTranscriptsCatalogCutoverMigration(pool);
    await runTranscriptDurationBackfillCutoverMigration(pool);
    await runTranscriptionLanguageCodeCutoverMigration(pool);
    await runEventTranscriptCardinalityCutoverMigration(pool);
    await runTranscriptionRequeueHeartbeatCutoverMigration(pool);
    await runFilesTypeOptionsCutoverMigration(pool);
    await runEventsCalendarPropertiesCutoverMigration(pool);
    await runEventsIcalIdentityCutoverMigration(pool);
    await runCalendarsCutoverMigration(pool);
    await runEventsAreaCutoverMigration(pool);
    await runEventsFilesRelationCutoverMigration(pool);
    await runProjectAgentGuidanceCutoverMigration(pool);
    await runProcessingProposalsCardStateCutoverMigration(pool);
    await runMailboxAddressesOwnerCutoverMigration(pool);
    await runEmailsSenderPeopleCardinalityCutoverMigration(pool);
    await runMailDraftsAndSentReadBackfill(pool);
    await runSelfPersonCutoverMigration(pool);
    await runLibraryBooksYearIsbnCutoverMigration(pool);
    await runLibraryHeartbeatConfigCutoverMigration(pool);
    await runAreasPropertiesCutoverMigration(pool);
    await runProjectsPinnedOrderCutoverMigration(pool);
    await runPeoplePhonesCutoverMigration(pool);
    await runPeopleLastContactCutoverMigration(pool);
    await runPeopleRelationshipOptionsCutoverMigration(pool);
    await runSelectOptionOrderCutoverMigration(pool);
    await runSelectOptionColorsCutoverMigration(pool);
    await runRatingFilterPresetsCutoverMigration(pool);
    await runProjectsCompletedAtCutoverMigration(pool);
    await runAreasUnplannedCutoverMigration(pool);
    await runNewEmailSenderFilterCutoverMigration(pool);
    await runTasksSchemaCutoverMigration(pool);
    await runTasksSourceEventsCutoverMigration(pool);
    await runTaskRecurrenceSeriesCutoverMigration(pool);
    await runJournalProjectCutoverMigration(pool);
    await runJournalEventsCutoverMigration(pool);
    // Last: it converts each area in its own transaction and reports failed areas only after every area ran.
    await runAreaNoteCutoverMigration(pool);
  });
}
