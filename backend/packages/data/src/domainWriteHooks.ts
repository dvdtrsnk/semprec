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
// The composition point for the choke point's per-process hook registries (chokePoint/hooks.ts):
// the one place that imports every domain's hook by name and registers it, so chokePoint/ itself
// never has to. Side-effect only — imported for its registration calls, not any export.
// `backend/packages/data/src/index.ts` imports this first, before anything else, so every
// process that loads @semprec/data registers these hooks before any write; a test importing a
// choke-point module by its deep path (bypassing the barrel) must import this file itself.
// See docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md.
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
import { linkRuleEdgeHook } from "./valueLinks/linkRuleEdgeHook.js";
import { valueLinkSourceDeleteHook } from "./valueLinks/valueLinkSourceDeleteHook.js";
import { mcpServerItemCreateHook, mcpServerItemUpdateHook } from "./mcp/mcpServerWriteHook.js";
import { recipePhotoWriteHook } from "./recipes/recipePhotoHook.js";
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
// Issue #1793: the user-owned cover properties of Books and Movies, after the Books year rule above.
registerItemPreWriteTransform(BOOKS_MODULE_ID, libraryCoverPreWriteTransform, prepareLibraryCoverWrite);
registerItemPreWriteTransform(MOVIES_MODULE_ID, libraryCoverPreWriteTransform, prepareLibraryCoverWrite);
registerItemPreWriteTransform(PROJECTS_MODULE_ID, projectWriteTransform, prepareProjectWrite);
registerItemPreWriteTransform(FILES_MODULE_ID, filesItemPreWriteTransform, async ({ stored, patch }) => ({
  patch,
  deferredKeys: stored === null && !Object.hasOwn(patch, "type") && Object.hasOwn(patch, "file") ? ["type"] : [],
}));
// Events: the time transform first, so the iCalendar sequence compares normalized times (issues #1598, #1599).
registerItemPreWriteTransform(EVENTS_MODULE_ID, eventTimePreWriteTransform, prepareEventTime);
registerItemPreWriteTransform(EVENTS_MODULE_ID, eventIcalIdentityTransform, prepareEventIcalIdentity);
// Issue gh-1905: the day a recurring Event is next on, after the time transform has normalized the day it reads.
registerItemPreWriteTransform(EVENTS_MODULE_ID, nextOccurrenceDateTransform, prepareNextOccurrenceDate);
// Issue gh-1905: a cancelled, restored or moved occurrence recomputes the day its series is next on.
registerItemUpdateHook(nextOccurrenceSeriesItemUpdateHook);
registerItemDeleteHook(nextOccurrenceSeriesItemDeleteHook);
registerItemRestoreHook(nextOccurrenceSeriesItemRestoreHook);
// Events: the date and time rules judge what the transforms above stored (issue #1663).
registerItemCreateHook(eventValidationItemCreateHook);
registerItemUpdateHook(eventValidationItemUpdateHook);
// Issue gh-1817: a written Events `recurrence` must be a fixed rule.
registerItemCreateHook(eventRecurrenceItemCreateHook);
registerItemUpdateHook(eventRecurrenceItemUpdateHook);
registerItemCreateHook(blobReferenceItemCreateHook);
registerItemUpdateHook(blobReferenceItemUpdateHook);
registerItemCreateHook(mcpServerItemCreateHook);
// Issue #1707: one hook for both registries, after the blob reference hooks above.
registerItemCreateHook(recipePhotoWriteHook);
registerItemCreateHook(itemSearchCreateHook);
registerItemUpdateHook(mcpServerItemUpdateHook);
registerItemUpdateHook(recipePhotoWriteHook);
registerItemUpdateHook(mailMessageFlagsItemUpdateHook);
registerItemUpdateHook(taskRecurrenceItemUpdateHook);
registerItemUpdateHook(itemSearchUpdateHook);
// Issue #1652: the documents that quote another item's text, rebuilt by queued jobs.
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
// Issue #1666: a restored Journal entry takes its period back, or the restore is refused while another entry holds it.
registerItemRestoreHook(journalItemRestoreHook);
registerItemCreateHook(journalDayRelinkItemCreateHook);
registerItemCreateHook(inboxItemCreateHook);
registerItemCreateHook(inboxTypeItemCreateHook);
registerItemUpdateHook(inboxTypeItemUpdateHook);
// Issue gh-1894: the permanent deletion of a Processing proposals card sweeps the expired stored responses of card actions.
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
// Issue gh-2031: a user's or an agent's trash of a Mailboxes item is refused; the mailbox removal
// trashes it as the system writer. The guard refuses an agent run's request before it is queued for approval.
registerItemDeleteHook(mailboxDeleteHook);
registerItemDeleteApprovalGuard(MAILBOXES_MODULE_ID, mailboxDeleteApprovalGuard);
// Issue gh-1691: the mail rows of a permanently deleted Emails or Mailboxes item go with it.
registerItemPurgeHook(mailItemPurgeHook);

registerItemCreateHook(areaItemCreateHook);
registerItemUpdateHook(areaItemUpdateHook);

registerItemUpdateHook(linkRuleItemHook);
// Issue gh-1869: a company created with a `web`, or restored from the trash, is an input of the resolver rules like
// an update of its `web`.
registerItemCreateHook(linkRuleItemCreateHook);
registerItemRestoreHook(linkRuleItemRestoreHook);
registerRelationEdgeChangedHook(linkRuleEdgeHook);
registerItemDeleteHook(valueLinkSourceDeleteHook);
// Issue gh-1869: every change of a thread's company or project, the link engine's included, publishes the thread's
// `mailThread` invalidation. Registered after `linkRuleEdgeHook`, which queues the evaluation of the rules that
// follow the change.
registerRelationEdgeChangedHook(threadValueEdgeChangedHook);
registerAutomationBatchReader(readAutomationForItems);

// Issue #1660: People `lastContact` follows its source edges, the sources' dates and their trash state.
registerRelationEdgeChangedHook(peopleLastContactEdgeChangedHook);
registerItemUpdateHook(peopleLastContactItemUpdateHook);
registerItemDeleteHook(peopleLastContactItemDeleteHook);
registerItemRestoreHook(peopleLastContactItemRestoreHook);

// Issue #1697: a transcript's company link ends when its Event edge is removed or its Event is trashed; the
// removal of the edge also detaches the Event from the transcript's project and people links.
registerRelationEdgeChangedHook(transcriptCompanyLinkReleaseEdgeChangedHook);
registerItemDeleteHook(transcriptCompanyLinkReleaseItemDeleteHook);

// Issue #1724: the removal of a Tasks `sourceEvents` edge detaches the Event from the task's project and people
// links of any state. Registered after `linkRuleEdgeHook`, which recomputes the links that are `on`.
registerRelationEdgeChangedHook(taskSourceEventLinkDetachEdgeChangedHook);

// Issue #1710: a project's area or company edge change queues the announcement of the project's items.
registerRelationEdgeChangedHook(projectDerivedValueEdgeChangedHook);

// Events: a write that names `alertMinutes` or `travelMinutes` gives an allowed value or `null` (issue #1714).
registerItemCreateHook(eventReminderValuesItemCreateHook);
registerItemUpdateHook(eventReminderValuesItemUpdateHook);

// Issue #1718: each reported `create` or `delete` of an Inbox type edge, a repeated create of an existing edge
// included, queues the Inbox tick and the recompute of the item's Journal day.
registerRelationEdgeChangedHook(inboxTypeEdgeChangedHook);

// Issue #1723: a trashed page takes its subpages and its block in its parent's document with it; a restore
// brings them back.
registerItemDeleteHook(pageItemDeleteHook);
registerItemRestoreHook(pageItemRestoreHook);

// Issue gh-2032: a restored mailbox without a sync state gets a default one, and its folders and messages of its
// deletion epoch return with it.
registerItemRestoreHook(mailboxItemRestoreHook);

// Issue #1757: the role and the server-written invitation on an Event's participant edges.
registerRelationEdgeWriteHook(eventParticipantEdgeWriteHook);

// Issue #1761: a new Event gets its calendar, after every Events rule registered above accepted it.
registerItemCreateHook(defaultCalendarCreateHook);

// Issue #1763: a trashed item of any database but Pages takes its live subpages with it, and its restore brings
// back the subpages of its deletion epoch.
registerItemDeleteHook(hostItemDeleteHook);
registerItemRestoreHook(hostItemRestoreHook);

// Issue #1778: the name, colour and single-default rules of a row of the Calendars database.
// Issue gh-1925: a subscription calendar's `subscriptionUrl` is normalized and judged before the row is written.
registerItemPreWriteTransform(CALENDARS_MODULE_ID, calendarSubscriptionUrlTransform, prepareCalendarSubscriptionUrl);
registerItemCreateHook(calendarItemCreateHook);
registerItemUpdateHook(calendarItemUpdateHook);
// An update that names `isDefault` takes the lock of the default mark before it locks the calendar's row.
registerItemUpdatePreLockHook(CALENDARS_MODULE_ID, calendarItemUpdatePreLockHook);

// Issue #1795: a person's `birthday` is empty or a real calendar date.
registerItemCreateHook(personBirthdayItemCreateHook);
registerItemUpdateHook(personBirthdayItemUpdateHook);
// Issue gh-1803: a calendar cannot be deleted when it is a system or subscription calendar or the last own one, the
// default mark moves to another own calendar, and the live Events of the calendar are trashed with it; a restore
// brings back the Events of the calendar's deletion epoch.
registerItemDeleteHook(calendarItemDeleteHook);
registerItemRestoreHook(calendarItemRestoreHook);
// A delete or a restore of a calendar takes the lock of the default mark before it locks the calendar's row.
registerItemDeletePreLockHook(CALENDARS_MODULE_ID, calendarItemDeletePreLockHook);
registerItemRestorePreLockHook(CALENDARS_MODULE_ID, calendarItemRestorePreLockHook);

// Issue gh-1784: the sleep databases store times as HH:MM, hold valid values, and allow one settings item and one
// exception per night.
for (const moduleId of [SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID]) {
  registerItemPreWriteTransform(moduleId, sleepPreWriteTransform, prepareSleepWrite);
}
registerItemCreateHook(sleepItemCreateHook);
registerItemUpdateHook(sleepItemUpdateHook);
// An update that names `night` takes the lock of that night before it locks the exception's row, the order of the PUT.
registerItemUpdatePreLockHook(SLEEP_NIGHTS_MODULE_ID, sleepNightUpdatePreLockHook);
// Issue gh-1799: a wake day is in at most one plan; the hooks run after the validation hooks above.
registerItemCreateHook(keepWakeDaysInOnePlan);
registerItemUpdateHook(keepWakeDaysInOnePlan);

// Issue #1780: a task's `hiddenUntil` and `effectiveDate` follow its host-event edges and those Events' dates and
// times. The third trigger, the task's own `date` and its create, is the Tasks transform registered above.
registerRelationEdgeChangedHook(taskHostEventEdgeChangedHook);
registerItemUpdateHook(taskHostEventScheduleItemUpdateHook);

// Issue #1781: a task set to `done` before the end of its last host event is completed in that event; setting it
// back to `notDone` or `wontDo` removes the edge. After the host state hooks of issue #1780 and the recurrence advance.
registerItemUpdateHook(taskCompletedInEventHook);

// Issue #1819: trashing an Event returns the tasks it hosts to their day (the edges stay); restoring it does not
// link them again and removes the edges, locking the tasks first. After the host state hooks of issue #1780, which the
// recomputations use. Recorded in docs/adr/2026-11-13-event-trash-and-restore-write-the-tasks-they-host.md.
registerItemDeleteHook(eventHostedTasksDeleteHook);
registerItemRestoreHook(eventHostedTasksRestoreHook);

// Issue gh-1882: deleting any instance of a recurring task series trashes every instance of the series with it, under one
// `deletedAt`, and restoring any of them restores the series. The pre-lock hooks lock the series before the cascade locks
// the task it names; the delete hook turns the repeat rule off and records its instance, the restore hook turns it on
// again for that instance. The Tasks delete impact (the instances, attachments and host events a delete reaches) is
// read by the delete preview and by the approval projection of `item.delete`. After the hooks of gh-1601 (the delete and
// restore registries), gh-1656 (the value link detach registered above, which makes the attachments' links their own),
// gh-1856 (the preview) and gh-1605 (the series identity), its declared blockers. Recorded in
// docs/adr/2026-11-14-a-recurring-task-series-is-trashed-and-restored-as-one-cascade.md.
registerItemCascadeExpansion(TASKS_MODULE_ID, taskSeriesCascadeExpansion);
registerItemDeletePreLockHook(TASKS_MODULE_ID, taskSeriesItemDeletePreLockHook);
registerItemRestorePreLockHook(TASKS_MODULE_ID, taskSeriesItemRestorePreLockHook);
registerItemPurgePreLockHook(TASKS_MODULE_ID, taskSeriesItemPurgePreLockHook);
registerItemDeleteHook(taskSeriesItemDeleteHook);
registerItemRestoreHook(taskSeriesItemRestoreHook);
registerItemDeleteImpactReader(TASKS_MODULE_ID, taskDeleteImpactReader);

// Issue gh-1838: every change of sleep data, and a change of the System settings time zone, enqueues the debounced
// resync push. After the validation and plan hooks above, so a write they refuse enqueues nothing, and after the hooks
// of issue #1819, the Shared-file ordering blocker of this issue.
registerItemCreateHook(sleepResyncCreateHook);
registerItemUpdateHook(sleepResyncUpdateHook);
registerItemDeleteHook(sleepResyncDeleteHook);
registerItemRestoreHook(sleepResyncRestoreHook);

// Issue gh-1812: the cover candidates of a permanently deleted item go with it, whatever its database (an item of
// another database has none). gh-1812 declares only #1809 as a blocker, and that one for shared-file ordering.
registerItemPurgeHook(libraryCoverCandidatesPurgeHook);

// Issue #1774: a moved or relocated Event queues an updated invitation for the people it was sent to, and a trashed
// Event queues a cancellation for the people it has an invitation for. No restore hook: a restore sends nothing.
registerItemUpdateHook(eventInvitationItemUpdateHook);
registerItemDeleteHook(eventInvitationItemDeleteHook);

// Issue gh-1945: a trashed transcript's Semp status problem is resolved as `sourceDeleted`. gh-1945 declares gh-1919 as
// its blocker, and gh-1919 registers no hook, so the entry has no registration order to keep.
registerItemDeleteHook(transcriptProblemDeleteHook);

// Issue gh-1942: a created or deleted Transcripts `event` edge, and a created or deleted Events `people` edge, queue the
// speaker suggestion of the transcripts concerned. It reads and writes nothing else, so its place among the edge hooks
// of other modules does not matter; it follows those of its blocker gh-1940, which registers none.
registerRelationEdgeChangedHook(transcriptSpeakerSuggestionEdgeChangedHook);

// Issue gh-1879: every write that can change a fire time of the reminders feed (an Event or a Task with a start, an offset, a
// switch or a status; a calendar's `notify`; the trash and the restore of an Event, a Task or a calendar; the System settings time
// zone) enqueues the debounced reminders resync push. Registered after the other hooks of this file, so a write one of them
// refuses throws before it enqueues, and after the sleep resync hooks of issue gh-1838, its Shared-file ordering blocker.
// Recorded in docs/adr/2026-11-14-a-reminders-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction.md.
registerItemCreateHook(remindersResyncCreateHook);
registerItemUpdateHook(remindersResyncUpdateHook);
registerItemDeleteHook(remindersResyncDeleteHook);
registerItemRestoreHook(remindersResyncRestoreHook);

// Issue sp-c30c3251-d5c3-4012-92a1-078257f3f83c: the groups of global search (search/searchGroupRegistry.ts). An item
// group searches the databases of its owner modules; `chat` is the thread group of the Semp conversations of a person.
// Issue gh-1864: `mail` is the thread group of the mail threads.
registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
registerItemSearchGroup({ type: "event", ownerModuleIds: [EVENTS_MODULE_ID] });
registerItemSearchGroup({ type: "project", ownerModuleIds: [PROJECTS_MODULE_ID] });
registerItemSearchGroup({ type: "area", ownerModuleIds: [AREAS_MODULE_ID] });
registerItemSearchGroup({ type: "contact", ownerModuleIds: [PEOPLE_MODULE_ID, COMPANIES_MODULE_ID] });
registerItemSearchGroup({ type: "journal", ownerModuleIds: [JOURNAL_MODULE_ID] });
registerItemSearchGroup({ type: "file", ownerModuleIds: [FILES_MODULE_ID] });
registerThreadSearchGroup(mailGlobalSearchGroup);
registerThreadSearchGroup(sempThreadSearchGroup);

// Issue gh-1874: the related collections of a person list their mail threads in the Threads collection (the People
// declaration in seed/systemDatabasesModuleManifest.ts omits the Emails collection). A read contributor, not a write
// hook: it runs in the read of `relation.related`
// (docs/adr/2026-11-13-related-rows-are-contributed-through-a-per-process-registry.md).
registerRelatedRowContributor(PEOPLE_MODULE_ID, personMailThreadsRelatedRow);

// Issue gh-1916: an open Processing proposals card that refers to a project that is archived, or to an item that is
// deleted, becomes `invalid` in the same transaction, and returns to `proposed` when the item comes back. gh-1905, the
// Shared-file ordering blocker of gh-1916, is on the branch; these entries go after its entries above.
registerItemUpdateHook(proposalReferenceItemUpdateHook);
registerItemDeleteHook(proposalReferenceItemDeleteHook);
registerItemRestoreHook(proposalReferenceItemRestoreHook);

// Issue gh-1923: a person newly linked to a message of a thread is queued for the people of the thread's tasks. gh-1923
// names #1916 and #2033 for shared-file ordering only; #1916's entries are above, #2033 registers no hook yet, and its
// entries go before this one.
registerRelationEdgeChangedHook(threadTaskPeopleEdgeChangedHook);
