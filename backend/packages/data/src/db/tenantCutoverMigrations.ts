import { runInboxMarkdownFormatCutoverMigration } from "../inbox/inboxMarkdownFormatCutoverMigration.js";
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
import { runTranscriptionTriggerEventsCutoverMigration } from "../transcription/transcriptionTriggerEventsCutoverMigration.js";
import { runEventsCalendarPropertiesCutoverMigration } from "../calendar/eventsCalendarPropertiesCutoverMigration.js";
import { runEventsIcalIdentityCutoverMigration } from "../calendar/eventsIcalIdentityCutoverMigration.js";
import { runCalendarsCutoverMigration } from "../calendar/calendarsCutoverMigration.js";
import { runPeopleEventsInverseCutoverMigration } from "../calendar/peopleEventsInverseCutoverMigration.js";
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
import { runTasksPersistentRemovalCutoverMigration } from "../tasks/tasksPersistentRemovalCutoverMigration.js";
import { runTasksDayRolloverHeartbeatCutoverMigration } from "../tasks/tasksDayRolloverHeartbeatCutoverMigration.js";
import { runTaskRecurrenceSeriesCutoverMigration } from "../tasks/taskRecurrenceSeriesCutoverMigration.js";
import { runJournalProjectCutoverMigration } from "../journal/journalProjectCutoverMigration.js";
import { runJournalEventsCutoverMigration } from "../journal/journalEventsCutoverMigration.js";
import { runPeopleRelationshipOptionsCutoverMigration } from "../seed/peopleRelationshipOptionsCutoverMigration.js";
import { runHealthRecordTagsCutoverMigration } from "../seed/healthRecordTagsCutoverMigration.js";
import { runHealthRecordTasksCutoverMigration } from "../seed/healthRecordTasksCutoverMigration.js";
import { runNewEmailSenderFilterCutoverMigration } from "../mail/newEmailSenderFilterCutoverMigration.js";
import { runAreaNoteCutoverMigration } from "../docs/areaNoteCutoverMigration.js";
import { runRecipesModuleCutoverMigration } from "../recipes/recipesModuleCutoverMigration.js";
import { runMeetingNotesBackfillCutoverMigration } from "../transcription/meetingNotesBackfillCutoverMigration.js";
import { runSleepModuleCutoverMigration } from "../sleep/sleepModuleCutoverMigration.js";
import { runLibraryCoverOverrideCutoverMigration } from "../library/libraryCoverOverrideCutoverMigration.js";
import { runPeopleBirthdayCutoverMigration } from "../calendar/peopleBirthdayCutoverMigration.js";
import { runSensitiveDatabasesCutoverMigration } from "../seed/sensitiveDatabasesCutoverMigration.js";
import { runTasksTodayViewCutoverMigration } from "../tasks/todayViewCutoverMigration.js";
import { runEventsRecurrenceCutoverMigration } from "../calendar/eventsRecurrenceCutoverMigration.js";
import { runTranscriptNameBackfillCutoverMigration } from "../transcription/transcriptNameBackfillCutoverMigration.js";
import { runSleepSettingsAreaCutoverMigration } from "../sleep/sleepSettingsAreaCutoverMigration.js";
import { runEventsOccurrenceCutoverMigration } from "../calendar/eventsOccurrenceCutoverMigration.js";

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
    await runTasksDayRolloverHeartbeatCutoverMigration(pool);
    await runFilesTypeOptionsCutoverMigration(pool);
    await runEventsCalendarPropertiesCutoverMigration(pool);
    await runEventsIcalIdentityCutoverMigration(pool);
    await runCalendarsCutoverMigration(pool);
    await runEventsAreaCutoverMigration(pool);
    await runEventsFilesRelationCutoverMigration(pool);
    await runPeopleEventsInverseCutoverMigration(pool);
    await runProjectAgentGuidanceCutoverMigration(pool);
    await runProcessingProposalsCardStateCutoverMigration(pool);
    await runInboxMarkdownFormatCutoverMigration(pool);
    // Issue #1698: after the Events/Files relation cutover of #1588, whose `Files.events` property it reads.
    await runTranscriptionTriggerEventsCutoverMigration(pool);
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
    await runHealthRecordTagsCutoverMigration(pool);
    await runSelectOptionColorsCutoverMigration(pool);
    await runRatingFilterPresetsCutoverMigration(pool);
    await runProjectsCompletedAtCutoverMigration(pool);
    await runAreasUnplannedCutoverMigration(pool);
    await runNewEmailSenderFilterCutoverMigration(pool);
    await runTasksSchemaCutoverMigration(pool);
    // Issue #2009: registered after the Tasks schema cutover of #1540.
    await runTasksPersistentRemovalCutoverMigration(pool);
    await runTasksSourceEventsCutoverMigration(pool);
    await runTaskRecurrenceSeriesCutoverMigration(pool);
    await runHealthRecordTasksCutoverMigration(pool);
    await runJournalProjectCutoverMigration(pool);
    await runJournalEventsCutoverMigration(pool);
    // Issue #1707: the Recipes module for a tenant seeded before it. It needs no other step's result and stands
    // after them, before the area-note cutover that stays last. The guidance cutover above has run before the
    // Recipes project exists, so this step writes that project's guidance row itself.
    await runRecipesModuleCutoverMigration(pool);
    await runMeetingNotesBackfillCutoverMigration(pool);
    // Issue #1779: the sleep module for a tenant seeded before it. It needs no other step's result and stands
    // after the steps of #1707 and #1712, before the area-note cutover that stays last.
    await runSleepModuleCutoverMigration(pool);
    // Issue #1793: the user-owned cover properties of Books and Movies. It needs no other step's result and stands
    // after the library steps above, which created and upgraded those schemas, before the area-note cutover.
    await runLibraryCoverOverrideCutoverMigration(pool);
    // Issue #1795: the People birthday properties for a tenant seeded before them. It needs no other step's result
    // and stands after the step of #1793, which it waits for, before the area-note cutover that stays last.
    await runPeopleBirthdayCutoverMigration(pool);
    // Issue #1808: marks Health records (and any sleep database a tenant already has) sensitive. The sleep
    // cutover above creates the sleep databases of a tenant seeded before them already flagged, so this step
    // only changes rows that existed without the flag.
    await runSensitiveDatabasesCutoverMigration(pool);
    // Issue #1798: the Today view of Tasks for a tenant seeded before it. Its filter names properties and relations
    // (`effectiveDate`, `hiddenUntil`, `completedOn`, `completedInEvent`) that the Tasks schema cutover above (#1540)
    // creates; the step stands before the area-note cutover that stays last.
    await runTasksTodayViewCutoverMigration(pool);
    // Issue gh-1817: the Events `recurrence` property. It needs no other step's result and stands after the
    // entry of issue #1808, a blocker of that issue, before the area-note cutover that stays last.
    await runEventsRecurrenceCutoverMigration(pool);
    // Issue gh-1830: clears the filename the create step used to copy into `Transcripts.name`. It needs no other
    // step's result and stands after the entry of issue gh-1817, a blocker of that issue, before the area-note
    // cutover that stays last.
    await runTranscriptNameBackfillCutoverMigration(pool);
    // Issue gh-1833: the `sleepSettings.area` relation. It needs the sleep databases of the module cutover of #1779
    // and the Areas database, and stands after the steps above (the entry of issue gh-1830, a blocker of that issue,
    // among them), before the area-note cutover that stays last.
    await runSleepSettingsAreaCutoverMigration(pool);
    // Issue gh-1843: the Events `seriesId` and `occurrenceDate` properties. It needs no other step's result and
    // stands after the recurrence step of gh-1817, before the area-note cutover that stays last.
    await runEventsOccurrenceCutoverMigration(pool);
    // Last: it converts each area in its own transaction and reports failed areas only after every area ran.
    await runAreaNoteCutoverMigration(pool);
  });
}
