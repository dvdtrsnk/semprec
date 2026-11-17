import {
  applyRecurrenceCommand,
  validateRecurrenceCommand,
  prepareRecurrenceCommand,
  projectRecurrenceApproval,
} from "./tasks/taskRecurrenceOwner.js";
import { inboxTypeLockWriteHook, inboxTypeLockChangedHook } from "./inbox/inboxTypeLockHook.js";
import { inboxTypeEdgeChangedHook } from "./inbox/inboxTypeEdgeHook.js";
import { prepareProjectWrite, projectWriteTransform } from "./projects/projectWriteTransform.js";
import { areaItemCreateHook, areaItemUpdateHook } from "./areas/areaWriteHook.js";
import { booksPreWriteTransform } from "./library/booksPreWriteTransform.js";
import { libraryCoverPreWriteTransform, prepareLibraryCoverWrite } from "./library/libraryCoverHooks.js";
import { libraryCoverCandidatesPurgeHook } from "./library/libraryCoverCandidatesPurgeHook.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./seed/libraryModuleKeys.js";
import {
  mailboxConnectionLimitCreateHook,
  mailboxConnectionLimitUpdateHook,
} from "./mail/mailboxConnectionLimitHook.js";
import { sanitizeMailHtml } from "./mail/htmlSanitize.js";
import { EMAILS_MODULE_ID, MAILBOXES_MODULE_ID } from "./seed/emailModuleKeys.js";
import { registerItemReadProjection } from "./chokePoint/hooks.js";
import { registerRelatedRowContributor } from "./chokePoint/relatedContributors.js";
import { personMailThreadsRelatedRow } from "./mail/threadRelatedCount.js";
import { threadTaskPeopleEdgeChangedHook } from "./mail/threadTaskPeople.js";
// Composition point for the choke point's per-process hook registries: the one place that imports every
// domain's hook and registers it, so chokePoint/ never has to. Side-effect only. `index.ts` imports it first,
// so every process registers before any write; a test that deep-imports a choke-point module (bypassing the
// barrel) must import this file itself.
import {
  registerItemCreateHook,
  registerItemPreWriteTransform,
  registerItemUpdateCommand,
  registerItemPatchApprovalContribution,
  registerItemUpdateHook,
  registerItemUpdatePreLockHook,
  registerItemDeletePreLockHook,
  registerItemRestorePreLockHook,
  registerItemPurgePreLockHook,
  registerRelationEdgeWriteHook,
  registerRelationEdgeDeleteHook,
  registerRelationEdgeBeforeLinkBreakHook,
  registerRelationEdgeChangedHook,
  registerAutomationBatchReader,
  registerItemRestoreHook,
  registerItemDeleteHook,
  registerItemDeleteApprovalGuard,
  registerItemCascadeExpansion,
  registerItemDeleteImpactReader,
  registerItemPurgeHook,
} from "./chokePoint/hooks.js";
import { readAutomationForItems } from "./library/itemAutomationStore.js";
import { linkRuleItemCreateHook, linkRuleItemHook, linkRuleItemRestoreHook } from "./valueLinks/linkRuleItemHook.js";
import { linkRuleEdgeHook, linkRuleEdgeLockHook } from "./valueLinks/linkRuleEdgeHook.js";
import { eventAttachmentLinkReleaseEdgeChangedHook } from "./blobs/eventAttachmentLinkRelease.js";
import { valueLinkSourceDeleteHook } from "./valueLinks/valueLinkSourceDeleteHook.js";
import { mcpServerItemCreateHook, mcpServerItemUpdateHook } from "./mcp/mcpServerWriteHook.js";
import { recipePhotoWriteHook } from "./recipes/recipePhotoHook.js";
import { recipeSourceUrlWriteHook } from "./recipes/recipeSourceUrlHook.js";
import { mailMessageFlagsItemUpdateHook } from "./mail/mailMessageFlagSyncStore.js";
import { mailItemPurgeHook } from "./mail/mailPurgeHook.js";
import { mailboxDeleteApprovalGuard, mailboxDeleteHook } from "./mail/mailboxDeleteHook.js";
import {
  AREAS_MODULE_ID,
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  JOURNAL_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "./seed/tenDatabaseKeys.js";
import { registerItemSearchGroup, registerThreadSearchGroup } from "./search/searchGroupRegistry.js";
import { sempThreadSearchGroup } from "./search/sempThreadSearch.js";
import { mailGlobalSearchGroup } from "./mail/mailGlobalSearchGroup.js";
import { calendarFeedStatePurgeHook } from "./calendar/calendarFeedStatePurgeHook.js";
import { registerCalendarFeedConsumer } from "./calendar/calendarSubscriptionSweep.js";
import { importSubscribedEvents } from "./calendar/subscribedEventsImport.js";
import { eventTimePreWriteTransform, prepareEventTime } from "./calendar/eventTime.js";
import { eventIcalIdentityTransform, prepareEventIcalIdentity } from "./calendar/eventIcalIdentityTransform.js";
import { nextOccurrenceDateTransform, prepareNextOccurrenceDate } from "./calendar/nextOccurrenceDateTransform.js";
import {
  nextOccurrenceSeriesItemDeleteHook,
  nextOccurrenceSeriesItemRestoreHook,
  nextOccurrenceSeriesItemUpdateHook,
} from "./calendar/nextOccurrenceSeriesHooks.js";
import { eventValidationItemCreateHook, eventValidationItemUpdateHook } from "./calendar/eventValidationHook.js";
import { eventRecurrenceItemCreateHook, eventRecurrenceItemUpdateHook } from "./calendar/eventRecurrenceHook.js";
import {
  eventReminderValuesItemCreateHook,
  eventReminderValuesItemUpdateHook,
} from "./calendar/eventReminderValuesHook.js";
import { eventParticipantEdgeWriteHook } from "./calendar/eventParticipantEdgeHook.js";
import { defaultCalendarCreateHook } from "./calendar/defaultCalendarCreateHook.js";
import { eventInvitationItemDeleteHook, eventInvitationItemUpdateHook } from "./calendar/eventInvitationHooks.js";
import {
  calendarItemCreateHook,
  calendarItemUpdateHook,
  calendarItemUpdatePreLockHook,
} from "./calendar/calendarRowHooks.js";
import { personBirthdayItemCreateHook, personBirthdayItemUpdateHook } from "./calendar/personBirthdayHook.js";
import {
  calendarItemDeleteHook,
  calendarItemDeletePreLockHook,
  calendarItemRestoreHook,
  calendarItemRestorePreLockHook,
} from "./calendar/calendarTrashHooks.js";
import { CALENDARS_MODULE_ID } from "./seed/calendarsKeys.js";
import {
  remindersResyncCreateHook,
  remindersResyncDeleteHook,
  remindersResyncRestoreHook,
  remindersResyncUpdateHook,
} from "./calendar/remindersResyncHooks.js";
import {
  calendarSubscriptionUrlTransform,
  prepareCalendarSubscriptionUrl,
} from "./calendar/calendarSubscriptionUrlTransform.js";
import { taskRecurrenceItemUpdateHook } from "./tasks/taskRecurrenceItemUpdateHook.js";
import { prepareTaskProposal, taskPreWriteTransform } from "./tasks/taskPreWriteTransform.js";
import { taskSourceEventLinkDetachEdgeChangedHook } from "./tasks/taskSourceEventLinkDetach.js";
import { taskHostEventEdgeChangedHook, taskHostEventScheduleItemUpdateHook } from "./tasks/taskHostEventHooks.js";
import { taskCompletedInEventHook } from "./tasks/taskCompletedInEventHook.js";
import { eventHostedTasksDeleteHook, eventHostedTasksRestoreHook } from "./tasks/eventHostedTasksHooks.js";
import {
  taskDeleteImpactReader,
  taskSeriesCascadeExpansion,
  taskSeriesItemDeleteHook,
  taskSeriesItemDeletePreLockHook,
  taskSeriesItemPurgePreLockHook,
  taskSeriesItemRestoreHook,
  taskSeriesItemRestorePreLockHook,
} from "./tasks/taskSeriesTrash.js";
import {
  threadValueEdgeChangedHook,
  threadValueEdgeDeleteHook,
  threadValueEdgeWriteHook,
} from "./mail/threadValueEdges.js";
import { transcriptSpeakerEdgeWriteHook } from "./transcription/transcriptionSpeakerEdges.js";
import { transcriptProblemDeleteHook } from "./transcription/transcriptProblemDeleteHook.js";
import { transcriptSpeakerSuggestionEdgeChangedHook } from "./transcription/transcriptSpeakerSuggestion.js";
import { transcriptRestoreHook } from "./transcription/transcriptRestoreHook.js";
import {
  transcriptCompanyLinkReleaseEdgeChangedHook,
  transcriptCompanyLinkReleaseItemDeleteHook,
} from "./transcription/transcriptCompanyLinkRelease.js";
import { itemSearchCreateHook, itemSearchUpdateHook } from "./search/itemSearchIndexer.js";
import {
  itemSearchDeleteHook,
  itemSearchEdgeChangedHook,
  itemSearchInboxCreateHook,
  itemSearchInboxUpdateHook,
  itemSearchRestoreHook,
  itemSearchTitleUpdateHook,
} from "./search/itemSearchFanout.js";
import {
  libraryRatingItemCreateHook,
  libraryRatingItemUpdateHook,
  libraryWatchedWithEdgeWriteHook,
} from "./library/libraryRatingHooks.js";
import { journalItemCreateHook } from "./journal/journalWriteHook.js";
import { journalItemRestoreHook } from "./journal/journalRestoreHook.js";
import { inboxItemCreateHook } from "./inbox/inboxCreateHook.js";
import { idempotentResponsesPurgeHook } from "./inbox/idempotentResponsesPurgeHook.js";
import {
  proposalReferenceItemDeleteHook,
  proposalReferenceItemRestoreHook,
  proposalReferenceItemUpdateHook,
} from "./inbox/proposalReferenceInvalidation.js";
import { journalDayRelinkItemCreateHook } from "./inbox/journalDayRelinkHook.js";
import { inboxTypeItemCreateHook, inboxTypeItemUpdateHook } from "./inbox/inboxTypeWriteHook.js";
import {
  inboxSourceEdgeDeleteHook,
  inboxSourceEdgeWriteHook,
  inboxTypeEdgeDeleteHook,
  inboxTypeEdgeWriteHook,
} from "./inbox/inboxSourceWriteHook.js";
import { blobReferenceItemCreateHook, blobReferenceItemUpdateHook } from "./blobs/blobReferenceWriteHook.js";
import { filesItemPreWriteTransform } from "./blobs/filesItemPreWriteTransform.js";
import {
  peopleLastContactEdgeChangedHook,
  peopleLastContactItemDeleteHook,
  peopleLastContactItemRestoreHook,
  peopleLastContactItemUpdateHook,
} from "./people/lastContactHooks.js";
import { projectDerivedValueEdgeChangedHook } from "./derived/projectDerivedValueHook.js";
import { hostItemDeleteHook, hostItemRestoreHook, pageItemDeleteHook, pageItemRestoreHook } from "./docs/pageTrash.js";
import { mailboxItemRestoreHook } from "./mail/mailboxRestoreHook.js";
import {
  keepWakeDaysInOnePlan,
  prepareSleepWrite,
  sleepItemCreateHook,
  sleepItemUpdateHook,
  sleepNightUpdatePreLockHook,
  sleepPreWriteTransform,
  sleepResyncCreateHook,
  sleepResyncDeleteHook,
  sleepResyncRestoreHook,
  sleepResyncUpdateHook,
} from "./sleep/sleepWriteHooks.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "./seed/sleepModuleKeys.js";

registerItemPreWriteTransform(TASKS_MODULE_ID, taskPreWriteTransform, prepareTaskProposal);
registerItemPatchApprovalContribution(TASKS_MODULE_ID, projectRecurrenceApproval);
registerItemUpdateCommand(TASKS_MODULE_ID, {
  key: "recurrence",
  transform: taskPreWriteTransform,
  validate: validateRecurrenceCommand,
  prepare: prepareRecurrenceCommand,
  consume: ({ client, stored, patch, writer }, value) => {
    if (!stored) throw new Error("Task command requires an existing item");
    return applyRecurrenceCommand(client, stored, patch, value, writer);
  },
});
registerItemPreWriteTransform(BOOKS_MODULE_ID, booksPreWriteTransform, async (context) => ({
  patch: await booksPreWriteTransform(context),
  deferredKeys: [],
}));
// Library cover properties, after the Books year rule above.
registerItemPreWriteTransform(BOOKS_MODULE_ID, libraryCoverPreWriteTransform, prepareLibraryCoverWrite);
registerItemPreWriteTransform(MOVIES_MODULE_ID, libraryCoverPreWriteTransform, prepareLibraryCoverWrite);
registerItemPreWriteTransform(PROJECTS_MODULE_ID, projectWriteTransform, prepareProjectWrite);
registerItemPreWriteTransform(FILES_MODULE_ID, filesItemPreWriteTransform, async ({ stored, patch }) => ({
  patch,
  deferredKeys: stored === null && !Object.hasOwn(patch, "type") && Object.hasOwn(patch, "file") ? ["type"] : [],
}));
// Events: the time transform first, so the iCalendar sequence compares normalized times.
registerItemPreWriteTransform(EVENTS_MODULE_ID, eventTimePreWriteTransform, prepareEventTime);
registerItemPreWriteTransform(EVENTS_MODULE_ID, eventIcalIdentityTransform, prepareEventIcalIdentity);
// The next occurrence day of a recurring Event, after the time transform normalized it.
registerItemPreWriteTransform(EVENTS_MODULE_ID, nextOccurrenceDateTransform, prepareNextOccurrenceDate);
// A cancelled, restored or moved occurrence recomputes its series' next occurrence day.
registerItemUpdateHook(nextOccurrenceSeriesItemUpdateHook);
registerItemDeleteHook(nextOccurrenceSeriesItemDeleteHook);
registerItemRestoreHook(nextOccurrenceSeriesItemRestoreHook);
// Events: the date and time rules judge what the transforms above stored.
registerItemCreateHook(eventValidationItemCreateHook);
registerItemUpdateHook(eventValidationItemUpdateHook);
registerItemCreateHook(eventRecurrenceItemCreateHook);
registerItemUpdateHook(eventRecurrenceItemUpdateHook);
registerItemCreateHook(blobReferenceItemCreateHook);
registerItemUpdateHook(blobReferenceItemUpdateHook);
registerItemCreateHook(mcpServerItemCreateHook);
// One hook for both registries, after the blob reference hooks above.
registerItemCreateHook(recipePhotoWriteHook);
// Recipe `sourceUrl`, after the photo hook above.
registerItemCreateHook(recipeSourceUrlWriteHook);
registerItemCreateHook(itemSearchCreateHook);
registerItemUpdateHook(mcpServerItemUpdateHook);
registerItemUpdateHook(recipePhotoWriteHook);
registerItemUpdateHook(recipeSourceUrlWriteHook);
registerItemUpdateHook(mailMessageFlagsItemUpdateHook);
registerItemUpdateHook(taskRecurrenceItemUpdateHook);
registerItemUpdateHook(itemSearchUpdateHook);
registerRelationEdgeChangedHook(itemSearchEdgeChangedHook);
registerItemUpdateHook(itemSearchTitleUpdateHook);
registerItemDeleteHook(itemSearchDeleteHook);
registerItemRestoreHook(itemSearchRestoreHook);
registerItemCreateHook(itemSearchInboxCreateHook);
registerItemUpdateHook(itemSearchInboxUpdateHook);
registerRelationEdgeWriteHook(transcriptSpeakerEdgeWriteHook);
registerItemRestoreHook(transcriptRestoreHook);
registerRelationEdgeWriteHook(threadValueEdgeWriteHook);
registerRelationEdgeDeleteHook(threadValueEdgeDeleteHook);
registerItemCreateHook(libraryRatingItemCreateHook);
registerItemUpdateHook(libraryRatingItemUpdateHook);
registerRelationEdgeWriteHook(libraryWatchedWithEdgeWriteHook);
registerRelationEdgeWriteHook(inboxTypeEdgeWriteHook);
registerRelationEdgeDeleteHook(inboxTypeEdgeDeleteHook);
registerRelationEdgeWriteHook(inboxTypeLockWriteHook);
registerRelationEdgeChangedHook(inboxTypeLockChangedHook);
registerRelationEdgeWriteHook(inboxSourceEdgeWriteHook);
registerRelationEdgeDeleteHook(inboxSourceEdgeDeleteHook);
registerItemCreateHook(journalItemCreateHook);
// A restored Journal entry takes its period back, or the restore is refused while another entry holds it.
registerItemRestoreHook(journalItemRestoreHook);
registerItemCreateHook(journalDayRelinkItemCreateHook);
registerItemCreateHook(inboxItemCreateHook);
registerItemCreateHook(inboxTypeItemCreateHook);
registerItemUpdateHook(inboxTypeItemUpdateHook);
// Purging a Processing proposals card sweeps the expired stored responses of its card actions.
registerItemPurgeHook(idempotentResponsesPurgeHook);

registerItemReadProjection({
  ownerModuleId: EMAILS_MODULE_ID,
  project: (item) =>
    typeof item.properties.body === "string"
      ? {
          ...item,
          properties: {
            ...item.properties,
            body: sanitizeMailHtml(item.properties.body, { allowRemoteImages: false }),
          },
        }
      : item,
});

registerItemCreateHook(mailboxConnectionLimitCreateHook);
registerItemUpdateHook(mailboxConnectionLimitUpdateHook);
// A user's or agent's trash of a Mailboxes item is refused (only the mailbox removal, as the system writer, trashes
// it); an agent run's request is refused before it is queued for approval.
registerItemDeleteHook(mailboxDeleteHook);
registerItemDeleteApprovalGuard(MAILBOXES_MODULE_ID, mailboxDeleteApprovalGuard);
registerItemPurgeHook(mailItemPurgeHook);

registerItemCreateHook(areaItemCreateHook);
registerItemUpdateHook(areaItemUpdateHook);

registerItemUpdateHook(linkRuleItemHook);
// A company created with a `web`, or restored, feeds the resolver rules like an update of its `web`.
registerItemCreateHook(linkRuleItemCreateHook);
registerItemRestoreHook(linkRuleItemRestoreHook);
// Removing a `Files.events` edge ends the file's company link. Must precede `linkRuleEdgeHook`: it reads the
// file's `projects` link, which that hook deletes.
registerRelationEdgeChangedHook(eventAttachmentLinkReleaseEdgeChangedHook);
registerRelationEdgeChangedHook(linkRuleEdgeHook);
// Takes the item row `linkRuleEdgeHook` locks, for a user or agent edge write, before the write ends a value link.
registerRelationEdgeBeforeLinkBreakHook(linkRuleEdgeLockHook);
registerItemDeleteHook(valueLinkSourceDeleteHook);
// Every change of a thread's company or project (link engine's included) publishes `mailThread`. After
// `linkRuleEdgeHook`, which queues the rule evaluation that follows the change.
registerRelationEdgeChangedHook(threadValueEdgeChangedHook);
registerAutomationBatchReader(readAutomationForItems);

registerRelationEdgeChangedHook(peopleLastContactEdgeChangedHook);
registerItemUpdateHook(peopleLastContactItemUpdateHook);
registerItemDeleteHook(peopleLastContactItemDeleteHook);
registerItemRestoreHook(peopleLastContactItemRestoreHook);

// A transcript's company link ends when its Event edge is removed or its Event trashed; removing the edge also
// detaches the Event from the transcript's project and people links.
registerRelationEdgeChangedHook(transcriptCompanyLinkReleaseEdgeChangedHook);
registerItemDeleteHook(transcriptCompanyLinkReleaseItemDeleteHook);

// Removing a Tasks `sourceEvents` edge detaches the Event from the task's project and people links of any state.
// After `linkRuleEdgeHook`, which recomputes the links that are `on`.
registerRelationEdgeChangedHook(taskSourceEventLinkDetachEdgeChangedHook);

registerRelationEdgeChangedHook(projectDerivedValueEdgeChangedHook);

registerItemCreateHook(eventReminderValuesItemCreateHook);
registerItemUpdateHook(eventReminderValuesItemUpdateHook);

// Each reported create or delete of an Inbox type edge (a repeated create included) queues the Inbox tick and
// the recompute of the item's Journal day.
registerRelationEdgeChangedHook(inboxTypeEdgeChangedHook);

// A trashed page takes its subpages and its block in the parent's document with it; restore brings them back.
registerItemDeleteHook(pageItemDeleteHook);
registerItemRestoreHook(pageItemRestoreHook);

// A restored mailbox without a sync state gets a default one; its folders and messages of its deletion epoch return.
registerItemRestoreHook(mailboxItemRestoreHook);

registerRelationEdgeWriteHook(eventParticipantEdgeWriteHook);

// A new Event gets its calendar, after every Events rule above accepted it.
registerItemCreateHook(defaultCalendarCreateHook);

// A trashed item of any database but Pages takes its live subpages with it; restore brings back those of its
// deletion epoch.
registerItemDeleteHook(hostItemDeleteHook);
registerItemRestoreHook(hostItemRestoreHook);

// Calendars: name, colour and single-default rules; a subscription's `subscriptionUrl` is normalized and judged
// before the row is written.
registerItemPreWriteTransform(CALENDARS_MODULE_ID, calendarSubscriptionUrlTransform, prepareCalendarSubscriptionUrl);
registerItemCreateHook(calendarItemCreateHook);
registerItemUpdateHook(calendarItemUpdateHook);
// Lock order: the default mark before the calendar's row.
registerItemUpdatePreLockHook(CALENDARS_MODULE_ID, calendarItemUpdatePreLockHook);

registerItemCreateHook(personBirthdayItemCreateHook);
registerItemUpdateHook(personBirthdayItemUpdateHook);
// A system, subscription or last own calendar cannot be deleted; the default mark moves to another own calendar
// and the calendar's live Events are trashed with it. Restore brings back the Events of its deletion epoch.
registerItemDeleteHook(calendarItemDeleteHook);
registerItemRestoreHook(calendarItemRestoreHook);
// Lock order: the default mark before the calendar's row.
registerItemDeletePreLockHook(CALENDARS_MODULE_ID, calendarItemDeletePreLockHook);
registerItemRestorePreLockHook(CALENDARS_MODULE_ID, calendarItemRestorePreLockHook);

// Sleep databases: HH:MM times, valid values, one settings item and one exception per night.
for (const moduleId of [SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID]) {
  registerItemPreWriteTransform(moduleId, sleepPreWriteTransform, prepareSleepWrite);
}
registerItemCreateHook(sleepItemCreateHook);
registerItemUpdateHook(sleepItemUpdateHook);
// Lock order: the night's lock before the exception's row, as the PUT does.
registerItemUpdatePreLockHook(SLEEP_NIGHTS_MODULE_ID, sleepNightUpdatePreLockHook);
// A wake day is in at most one plan; after the validation hooks above.
registerItemCreateHook(keepWakeDaysInOnePlan);
registerItemUpdateHook(keepWakeDaysInOnePlan);

// A task's `hiddenUntil` and `effectiveDate` follow its host-event edges and those Events' dates and times
// (the task's own `date` and create are handled by the Tasks transform above).
registerRelationEdgeChangedHook(taskHostEventEdgeChangedHook);
registerItemUpdateHook(taskHostEventScheduleItemUpdateHook);

// A task set to `done` before the end of its last host event is completed in that event; back to `notDone` or
// `wontDo` removes the edge. After the host-state hooks and the recurrence advance.
registerItemUpdateHook(taskCompletedInEventHook);

// Trashing an Event returns its hosted tasks to their day (edges stay); restoring it removes the edges instead of
// relinking, locking the tasks first. After the host-state hooks, which the recomputations use.
registerItemDeleteHook(eventHostedTasksDeleteHook);
registerItemRestoreHook(eventHostedTasksRestoreHook);

// Deleting any instance of a recurring task series trashes the whole series under one `deletedAt`; restoring any
// instance restores it. The pre-lock hooks lock the series before the cascade locks the named task; the delete hook
// turns the repeat rule off and records its instance, the restore hook turns it back on. The delete impact reader
// feeds the delete preview and the `item.delete` approval projection. Must follow the value-link detach above, which
// makes the attachments' links their own.
registerItemCascadeExpansion(TASKS_MODULE_ID, taskSeriesCascadeExpansion);
registerItemDeletePreLockHook(TASKS_MODULE_ID, taskSeriesItemDeletePreLockHook);
registerItemRestorePreLockHook(TASKS_MODULE_ID, taskSeriesItemRestorePreLockHook);
registerItemPurgePreLockHook(TASKS_MODULE_ID, taskSeriesItemPurgePreLockHook);
registerItemDeleteHook(taskSeriesItemDeleteHook);
registerItemRestoreHook(taskSeriesItemRestoreHook);
registerItemDeleteImpactReader(TASKS_MODULE_ID, taskDeleteImpactReader);

// Every change of sleep data, or of the System settings time zone, enqueues the debounced resync push. After the
// validation and plan hooks, so a refused write enqueues nothing.
registerItemCreateHook(sleepResyncCreateHook);
registerItemUpdateHook(sleepResyncUpdateHook);
registerItemDeleteHook(sleepResyncDeleteHook);
registerItemRestoreHook(sleepResyncRestoreHook);

registerItemPurgeHook(libraryCoverCandidatesPurgeHook);

registerItemPurgeHook(calendarFeedStatePurgeHook);

// A downloaded ICS feed becomes the calendar's `subscribedEvents` items. Not a write hook: the feed sweep calls it
// inside its own per-calendar transaction.
registerCalendarFeedConsumer(async (client, feed) => {
  await importSubscribedEvents(client, feed);
});

// A moved Event queues an updated invitation, a trashed one a cancellation. A restore sends nothing.
registerItemUpdateHook(eventInvitationItemUpdateHook);
registerItemDeleteHook(eventInvitationItemDeleteHook);

registerItemDeleteHook(transcriptProblemDeleteHook);

// Transcripts `event` and Events `people` edge changes queue the speaker suggestion of the affected transcripts.
// It touches nothing else, so its position among edge hooks does not matter.
registerRelationEdgeChangedHook(transcriptSpeakerSuggestionEdgeChangedHook);

// Every write that can change a reminders-feed fire time enqueues the debounced resync push. After the validation
// hooks, so a refused write throws before it enqueues.
registerItemCreateHook(remindersResyncCreateHook);
registerItemUpdateHook(remindersResyncUpdateHook);
registerItemDeleteHook(remindersResyncDeleteHook);
registerItemRestoreHook(remindersResyncRestoreHook);

registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
registerItemSearchGroup({ type: "event", ownerModuleIds: [EVENTS_MODULE_ID] });
registerItemSearchGroup({ type: "project", ownerModuleIds: [PROJECTS_MODULE_ID] });
registerItemSearchGroup({ type: "area", ownerModuleIds: [AREAS_MODULE_ID] });
registerItemSearchGroup({ type: "contact", ownerModuleIds: [PEOPLE_MODULE_ID, COMPANIES_MODULE_ID] });
registerItemSearchGroup({ type: "journal", ownerModuleIds: [JOURNAL_MODULE_ID] });
registerItemSearchGroup({ type: "file", ownerModuleIds: [FILES_MODULE_ID] });
registerThreadSearchGroup(mailGlobalSearchGroup);
registerThreadSearchGroup(sempThreadSearchGroup);

// A read contributor, not a write hook: a person's related collections list their mail threads under Threads
// (the People manifest omits the Emails collection).
registerRelatedRowContributor(PEOPLE_MODULE_ID, personMailThreadsRelatedRow);

// An open Processing proposals card that refers to an archived project or deleted item becomes `invalid` in the
// same transaction, and returns to `proposed` when the item comes back.
registerItemUpdateHook(proposalReferenceItemUpdateHook);
registerItemDeleteHook(proposalReferenceItemDeleteHook);
registerItemRestoreHook(proposalReferenceItemRestoreHook);

registerRelationEdgeChangedHook(threadTaskPeopleEdgeChangedHook);
