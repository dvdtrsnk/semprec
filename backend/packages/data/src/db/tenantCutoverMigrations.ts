import { runInboxMarkdownFormatCutoverMigration } from "../inbox/inboxMarkdownFormatCutoverMigration.js";
import { runAreasUnplannedCutoverMigration } from "../seed/areasUnplannedCutoverMigration.js";
import { runProjectsCompletedAtCutoverMigration } from "../seed/projectsCompletedAtCutoverMigration.js";
import { runSelectOptionColorsCutoverMigration } from "../seed/selectOptionColorsCutoverMigration.js";
import { runRatingFilterPresetsCutoverMigration } from "../seed/ratingFilterPresetsCutoverMigration.js";
import { runSelectOptionOrderCutoverMigration } from "../seed/selectOptionOrderCutoverMigration.js";
import { runThreadsDatabaseCutoverMigration } from "../mail/threadsDatabaseCutoverMigration.js";
import { runThreadTasksCutoverMigration } from "../mail/threadTasksCutoverMigration.js";
import { runThreadAttachmentsCutoverMigration } from "../mail/threadAttachmentsCutoverMigration.js";
import { runThreadTaskProposalCutoverMigration } from "../mail/threadTaskProposalCutoverMigration.js";
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
import { runInvitationIngestHeartbeatCutoverMigration } from "../calendar/invitationIngestHeartbeatCutoverMigration.js";
import { runInvitationsDatabaseCutoverMigration } from "../calendar/invitationsDatabaseCutoverMigration.js";
import { runNextOccurrenceDateCutoverMigration } from "../calendar/nextOccurrenceDateCutoverMigration.js";
import { runPeopleEventsInverseCutoverMigration } from "../calendar/peopleEventsInverseCutoverMigration.js";
import { runProjectAgentGuidanceCutoverMigration } from "../projectAgentGuidance/projectAgentGuidanceCutoverMigration.js";
import { runProcessingProposalsCardStateCutoverMigration } from "../inbox/processingProposalsCardStateCutoverMigration.js";
import { runProcessingProposalsSplitCutoverMigration } from "../inbox/processingProposalsSplitCutoverMigration.js";
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
import { runJournalWeeklyCleanupCutoverMigration } from "../journal/journalWeeklyCleanupCutoverMigration.js";
import { runPeopleRelationshipOptionsCutoverMigration } from "../seed/peopleRelationshipOptionsCutoverMigration.js";
import { runHealthRecordTagsCutoverMigration } from "../seed/healthRecordTagsCutoverMigration.js";
import { runHealthRecordTasksCutoverMigration } from "../seed/healthRecordTasksCutoverMigration.js";
import { runNewEmailSenderFilterCutoverMigration } from "../mail/newEmailSenderFilterCutoverMigration.js";
import { runNewEmailDraftCutoverMigration } from "../mail/newEmailDraftCutoverMigration.js";
import { runEmailGuidanceCutoverMigration } from "../mail/emailGuidanceCutoverMigration.js";
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
import { runCalendarSubscriptionUrlCutoverMigration } from "../calendar/calendarSubscriptionUrlCutoverMigration.js";
import { runSempProblemsBackfillCutoverMigration } from "../semp/sempProblemsBackfillCutoverMigration.js";
import { runSubscribedEventsCutoverMigration } from "../calendar/subscribedEventsCutoverMigration.js";

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
    // Issue gh-1905: the Events `nextOccurrenceDate` property, its backfill and the daily refresh heartbeat. It needs the
    // calendars cutover (#1600) above, whose project owns the heartbeat, and stands after the occurrence step of gh-1843,
    // before the area-note cutover that stays last.
    await runNextOccurrenceDateCutoverMigration(pool);
    // Issue gh-1883: the weekly Journal cleanup heartbeat on the Semprec project. It needs no other step's result and
    // stands after the entries of the sources it declares as blockers, before the area-note cutover that stays last.
    await runJournalWeeklyCleanupCutoverMigration(pool);
    // Issue gh-1898: the `Threads.attachments` relation. It needs the Threads database of the cutover of #1573 and the
    // Files database, and stands after the entries of the sources it declares as blockers, before the area-note
    // cutover that stays last.
    await runThreadAttachmentsCutoverMigration(pool);
    // Issue gh-2034: the `mailThread` card kind and the Processing proposals `sourceThread` relation. It needs the
    // Threads database of the thread cutover above and stands after the Threads tasks cutover of #1612, before the
    // area-note cutover that stays last.
    await runThreadTaskProposalCutoverMigration(pool);
    // Issue gh-1901: the invitations database of the calendar module. It needs the Calendars database of the cutover
    // of #1600 above and the Events, Emails and Mailboxes databases the seed created, and stands after the entries of
    // the sources it declares as blockers, before the area-note cutover that stays last.
    await runInvitationsDatabaseCutoverMigration(pool);
    // Issue gh-1939: the `splitFromProposalId` property of Processing proposals. It needs no other step's result and
    // stands after the entries of the sources it declares as blockers and before the entry of gh-1941, which named it as
    // a shared-file ordering blocker, and before the area-note cutover that stays last.
    await runProcessingProposalsSplitCutoverMigration(pool);
    // Issue gh-1941: the `runProject` and `answerExpectedFilter` keys of the `newEmail` heartbeat. It needs the sender
    // filter step of gh-1552 above, whose heartbeat it extends, and stands after the entry of gh-2034, before the
    // area-note cutover that stays last. The source declares #1939 as a shared-file ordering blocker; when that source
    // lands later, its entry goes before this one.
    await runNewEmailDraftCutoverMigration(pool);
    // Issue gh-1941: the Email project's guidance that names the real mail tools. It needs the guidance rows of the
    // cutover of #1449 above and stands after the heartbeat step of this issue, before the area-note cutover that stays
    // last.
    await runEmailGuidanceCutoverMigration(pool);
    // Issue gh-1925: the Calendars `subscriptionUrl` property. It needs the Calendars database of the step of #1600 and
    // stands after the steps above, before the area-note cutover that stays last.
    await runCalendarSubscriptionUrlCutoverMigration(pool);
    // Issue gh-1929: the `calendar.ingestInvitation` heartbeat on the Emails database. It needs the invitations database
    // of the step above and the Emails database, and stands after the entries of the sources it declares as blockers,
    // before the area-note cutover that stays last.
    await runInvitationIngestHeartbeatCutoverMigration(pool);
    // Issue gh-1958: raises the Semp problems of the failures that exist at deploy, under the keys of the producers
    // (#1911, #1465, #1506, #1945) it reads: mailboxes, guidance drift findings, heartbeats, library automation and
    // transcriptions. It needs no other step's result. None of its declared blockers (#1506, #1945, #1950) has a
    // cutover entry above yet; the entry of #1950 must be inserted above this call when it lands. Stands before the
    // area-note cutover that stays last.
    await runSempProblemsBackfillCutoverMigration(pool);
    // Issue gh-1962: the `subscribedEvents` database and its `calendar` relation. It needs the Calendars database of the
    // calendars cutover (#1600) above and stands after the entries of the sources it declares as blockers (#1958 above), before the
    // area-note cutover that stays last.
    await runSubscribedEventsCutoverMigration(pool);
    // Last: it converts each area in its own transaction and reports failed areas only after every area ran.
    await runAreaNoteCutoverMigration(pool);
  });
}
