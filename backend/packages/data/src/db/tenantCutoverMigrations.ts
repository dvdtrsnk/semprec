import { runProjectsPinnedOrderCutoverMigration } from "../seed/projectsPinnedOrderCutoverMigration.js";
import { runAreasPropertiesCutoverMigration } from "../seed/areasPropertiesCutoverMigration.js";
import { runLibraryBooksYearIsbnCutoverMigration } from "../library/libraryBooksYearIsbnCutoverMigration.js";
import { runSelfPersonCutoverMigration } from "../tenancy/selfPersonCutoverMigration.js";
import { runTranscriptionLanguageCodeCutoverMigration } from "../transcription/transcriptionLanguageCodeCutoverMigration.js";
import { runTranscriptDurationBackfillCutoverMigration } from "../transcription/transcriptDurationBackfillCutoverMigration.js";
import { runPropertyDefaultsCutoverMigration } from "../seed/propertyDefaultsCutoverMigration.js";
import type { Pool } from "pg";
import { runEventsAreaCutoverMigration } from "../events/eventsAreaCutoverMigration.js";
import { assertRowSecurityActive, forEachMaintainedTenant } from "../tenancy/provisionTenant.js";
import { runFilesTypeOptionsCutoverMigration } from "../blobs/filesTypeOptionsCutoverMigration.js";
import { runTranscriptsCatalogCutoverMigration } from "../transcription/transcriptsCatalogCutoverMigration.js";
import { runEventTranscriptCardinalityCutoverMigration } from "../transcription/eventTranscriptCardinalityCutoverMigration.js";
import { runTranscriptionRequeueHeartbeatCutoverMigration } from "../transcription/transcriptionRequeueHeartbeatCutoverMigration.js";
import { runEventsCalendarPropertiesCutoverMigration } from "../calendar/eventsCalendarPropertiesCutoverMigration.js";
import { runProjectAgentGuidanceCutoverMigration } from "../projectAgentGuidance/projectAgentGuidanceCutoverMigration.js";
import { runProcessingProposalsCardStateCutoverMigration } from "../inbox/processingProposalsCardStateCutoverMigration.js";
import { runMailboxAddressesOwnerCutoverMigration } from "../mail/mailboxAddressesOwnerCutoverMigration.js";
import { runEmailsSenderPeopleCardinalityCutoverMigration } from "../mail/emailsSenderPeopleCardinalityCutoverMigration.js";
import { runMailDraftsAndSentReadBackfill } from "../mail/mailDraftsAndSentReadBackfill.js";
import { runMailDatabaseKeysCutoverMigration } from "../mail/mailDatabaseKeysCutoverMigration.js";
import { runPeoplePhonesCutoverMigration } from "../seed/peoplePhonesCutoverMigration.js";
import { runTasksSchemaCutoverMigration } from "../tasks/tasksSchemaCutoverMigration.js";
import { runTasksSourceEventsCutoverMigration } from "../tasks/tasksSourceEventsCutoverMigration.js";
import { runJournalProjectCutoverMigration } from "../journal/journalProjectCutoverMigration.js";
import { runPeopleRelationshipOptionsCutoverMigration } from "../seed/peopleRelationshipOptionsCutoverMigration.js";

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
    await runMailDatabaseKeysCutoverMigration(pool);
    await runPropertyDefaultsCutoverMigration(pool);
    await runTranscriptsCatalogCutoverMigration(pool);
    await runTranscriptDurationBackfillCutoverMigration(pool);
    await runTranscriptionLanguageCodeCutoverMigration(pool);
    await runEventTranscriptCardinalityCutoverMigration(pool);
    await runTranscriptionRequeueHeartbeatCutoverMigration(pool);
    await runFilesTypeOptionsCutoverMigration(pool);
    await runEventsCalendarPropertiesCutoverMigration(pool);
    await runEventsAreaCutoverMigration(pool);
    await runProjectAgentGuidanceCutoverMigration(pool);
    await runProcessingProposalsCardStateCutoverMigration(pool);
    await runMailboxAddressesOwnerCutoverMigration(pool);
    await runEmailsSenderPeopleCardinalityCutoverMigration(pool);
    await runMailDraftsAndSentReadBackfill(pool);
    await runSelfPersonCutoverMigration(pool);
    await runLibraryBooksYearIsbnCutoverMigration(pool);
    await runAreasPropertiesCutoverMigration(pool);
    await runProjectsPinnedOrderCutoverMigration(pool);
    await runPeoplePhonesCutoverMigration(pool);
    await runPeopleRelationshipOptionsCutoverMigration(pool);
    await runTasksSchemaCutoverMigration(pool);
    await runTasksSourceEventsCutoverMigration(pool);
    await runJournalProjectCutoverMigration(pool);
  });
}
