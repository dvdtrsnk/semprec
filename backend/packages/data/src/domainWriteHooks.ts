// Composition point for the choke point's per-process hook registries: the one place that imports every
// domain's hook and registers it, so chokePoint/ never has to. Side-effect only. `index.ts` imports it first,
// so every process registers before any write; a test that deep-imports a choke-point module (bypassing the
// barrel) must import this file itself.
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
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "./seed/libraryModuleKeys.js";
import {
  mailboxConnectionLimitCreateHook,
  mailboxConnectionLimitUpdateHook,
} from "./mail/mailboxConnectionLimitHook.js";
import { mailboxServiceItemUpdateHook, mailboxServiceItemUpdatePreLockHook } from "./mail/mailboxServiceHooks.js";
import { sanitizeMailHtml } from "./mail/htmlSanitize.js";
import { EMAILS_MODULE_ID, MAILBOXES_MODULE_ID } from "./seed/emailModuleKeys.js";
import { registerItemReadProjection } from "./chokePoint/hooks.js";
import { registerRelatedRowContributor } from "./chokePoint/relatedContributors.js";
import { personMailThreadsRelatedRow } from "./mail/threadRelatedCount.js";
import { threadTaskPeopleEdgeChangedHook } from "./mail/threadTaskPeople.js";
import {
  type ItemCreateHook,
  type ItemDeleteHook,
  type ItemPreWritePreparation,
  type ItemPreWriteTransform,
  type ItemPurgeHook,
  type ItemRestoreHook,
  type ItemDeletePreLockHook,
  type ItemRestorePreLockHook,
  type ItemPurgePreLockHook,
  type ItemUpdateHook,
  type ItemUpdatePreLockHook,
  type RelationEdgeBeforeLinkBreakHook,
  type RelationEdgeChangedHook,
  type RelationEdgeDeleteHook,
  type RelationEdgeWriteHook,
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
  prepareSyncedRecurrence,
  syncedEventItemCreateHook,
  syncedEventItemUpdateHook,
  syncedRecurrenceTransform,
} from "./calendar/syncedEventFields.js";
import {
  eventReminderValuesItemCreateHook,
  eventReminderValuesItemUpdateHook,
} from "./calendar/eventReminderValuesHook.js";
import { eventParticipantEdgeWriteHook } from "./calendar/eventParticipantEdgeHook.js";
import { defaultCalendarCreateHook } from "./calendar/defaultCalendarCreateHook.js";
import {
  accountCalendarEventDeleteApprovalGuard,
  accountCalendarEventDeleteHook,
  accountCalendarEventDeletePreLockHook,
  accountCalendarEventEdgeDeleteHook,
  accountCalendarEventEdgeWriteHook,
  accountCalendarEventUpdateHook,
  accountCalendarEventUpdatePreLockHook,
} from "./calendar/accountCalendarWriteGuard.js";
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
import { projectAttachmentAreaEdgeChangedHook } from "./derived/projectAttachmentAreaHook.js";
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

// Each list below is the complete, ordered set of rules for one write event: hooks run sequentially in list order
// inside the writer's transaction, and the first rejection rolls the write back. Order matters only within a list.

/** Per owning module, in run order; each transform receives the previous one's output. */
const itemPreWriteTransforms: readonly (readonly [string, ItemPreWriteTransform, ItemPreWritePreparation])[] = [
  [TASKS_MODULE_ID, taskPreWriteTransform, prepareTaskProposal],
  [
    BOOKS_MODULE_ID,
    booksPreWriteTransform,
    async (context) => ({
      patch: await booksPreWriteTransform(context),
      deferredKeys: [],
    }),
  ],
  // Library cover properties, after the Books year rule above.
  [BOOKS_MODULE_ID, libraryCoverPreWriteTransform, prepareLibraryCoverWrite],
  [MOVIES_MODULE_ID, libraryCoverPreWriteTransform, prepareLibraryCoverWrite],
  [PROJECTS_MODULE_ID, projectWriteTransform, prepareProjectWrite],
  [
    FILES_MODULE_ID,
    filesItemPreWriteTransform,
    async ({ stored, patch }) => ({
      patch,
      deferredKeys: stored === null && !Object.hasOwn(patch, "type") && Object.hasOwn(patch, "file") ? ["type"] : [],
    }),
  ],
  // Events: the time transform first, so the iCalendar sequence compares normalized times.
  [EVENTS_MODULE_ID, eventTimePreWriteTransform, prepareEventTime],
  [EVENTS_MODULE_ID, eventIcalIdentityTransform, prepareEventIcalIdentity],
  // A `recurrence` edit of a synced series clears its raw rule, before the next occurrence day reads the rule.
  [EVENTS_MODULE_ID, syncedRecurrenceTransform, prepareSyncedRecurrence],
  // The next occurrence day of a recurring Event, after the time transform normalized it.
  [EVENTS_MODULE_ID, nextOccurrenceDateTransform, prepareNextOccurrenceDate],
  // A calendar subscription's `subscriptionUrl` is normalized and judged before the row is written.
  [CALENDARS_MODULE_ID, calendarSubscriptionUrlTransform, prepareCalendarSubscriptionUrl],
  // Sleep databases: HH:MM times, valid values, one settings item and one exception per night.
  [SLEEP_SETTINGS_MODULE_ID, sleepPreWriteTransform, prepareSleepWrite],
  [SLEEP_PLANS_MODULE_ID, sleepPreWriteTransform, prepareSleepWrite],
  [SLEEP_NIGHTS_MODULE_ID, sleepPreWriteTransform, prepareSleepWrite],
];

/** Per owning module; a pre-lock hook only takes the locks that must precede the item's row lock. */
const itemUpdatePreLockHooks: readonly (readonly [string, ItemUpdatePreLockHook])[] = [
  // Lock order: the default mark before the calendar's row.
  [CALENDARS_MODULE_ID, calendarItemUpdatePreLockHook],
  // Lock order: the night's lock before the exception's row, as the PUT does.
  [SLEEP_NIGHTS_MODULE_ID, sleepNightUpdatePreLockHook],
  // Lock order: the mailbox's sync guard and sync state row before the Mailboxes row, as a removal takes them.
  [MAILBOXES_MODULE_ID, mailboxServiceItemUpdatePreLockHook],
  // Lock order: an Event's account calendar before the Event's row, as a calendar trash takes them.
  [EVENTS_MODULE_ID, accountCalendarEventUpdatePreLockHook],
];

const itemDeletePreLockHooks: readonly (readonly [string, ItemDeletePreLockHook])[] = [
  // Lock order: the default mark before the calendar's row.
  [CALENDARS_MODULE_ID, calendarItemDeletePreLockHook],
  // The whole recurring task series, before the cascade locks the named task.
  [TASKS_MODULE_ID, taskSeriesItemDeletePreLockHook],
  // Lock order: an Event's account calendar before the Event's row, as a calendar trash takes them.
  [EVENTS_MODULE_ID, accountCalendarEventDeletePreLockHook],
];

const itemRestorePreLockHooks: readonly (readonly [string, ItemRestorePreLockHook])[] = [
  [CALENDARS_MODULE_ID, calendarItemRestorePreLockHook],
  [TASKS_MODULE_ID, taskSeriesItemRestorePreLockHook],
];

const itemPurgePreLockHooks: readonly (readonly [string, ItemPurgePreLockHook])[] = [
  [TASKS_MODULE_ID, taskSeriesItemPurgePreLockHook],
];

/** After a real insert. */
const itemCreateHooks: readonly ItemCreateHook[] = [
  // Events: the date and time rules judge what the transforms stored.
  eventValidationItemCreateHook,
  eventRecurrenceItemCreateHook,
  syncedEventItemCreateHook,
  blobReferenceItemCreateHook,
  mcpServerItemCreateHook,
  // After the blob reference hook.
  recipePhotoWriteHook,
  // Recipe `sourceUrl`, after the photo hook.
  recipeSourceUrlWriteHook,
  itemSearchCreateHook,
  itemSearchInboxCreateHook,
  libraryRatingItemCreateHook,
  journalItemCreateHook,
  journalDayRelinkItemCreateHook,
  inboxItemCreateHook,
  inboxTypeItemCreateHook,
  mailboxConnectionLimitCreateHook,
  areaItemCreateHook,
  // A company created with a `web` feeds the resolver rules like an update of its `web`.
  linkRuleItemCreateHook,
  eventReminderValuesItemCreateHook,
  // A new Event gets its calendar, after every Events rule above accepted it.
  defaultCalendarCreateHook,
  // Calendars: name, colour and single-default rules.
  calendarItemCreateHook,
  personBirthdayItemCreateHook,
  sleepItemCreateHook,
  // A wake day is in at most one plan; after the sleep validation hook.
  keepWakeDaysInOnePlan,
  // Every change of sleep data, or of the System settings time zone, enqueues the debounced resync push. After the
  // validation and plan hooks, so a refused write enqueues nothing.
  sleepResyncCreateHook,
  // Every write that can change a reminders-feed fire time enqueues the debounced resync push. After the validation
  // hooks, so a refused write throws before it enqueues.
  remindersResyncCreateHook,
];

/** After the row update. */
const itemUpdateHooks: readonly ItemUpdateHook[] = [
  // A user's or agent's change of an Event in a read-only account calendar is refused before any other rule runs.
  accountCalendarEventUpdateHook,
  // A cancelled, restored or moved occurrence recomputes its series' next occurrence day.
  nextOccurrenceSeriesItemUpdateHook,
  eventValidationItemUpdateHook,
  eventRecurrenceItemUpdateHook,
  syncedEventItemUpdateHook,
  blobReferenceItemUpdateHook,
  mcpServerItemUpdateHook,
  recipePhotoWriteHook,
  recipeSourceUrlWriteHook,
  mailMessageFlagsItemUpdateHook,
  taskRecurrenceItemUpdateHook,
  itemSearchUpdateHook,
  itemSearchTitleUpdateHook,
  itemSearchInboxUpdateHook,
  libraryRatingItemUpdateHook,
  inboxTypeItemUpdateHook,
  mailboxConnectionLimitUpdateHook,
  // Switching an account's Mail off pauses its sync and queues the removal of its mail; on resumes the sync.
  mailboxServiceItemUpdateHook,
  areaItemUpdateHook,
  linkRuleItemHook,
  peopleLastContactItemUpdateHook,
  eventReminderValuesItemUpdateHook,
  calendarItemUpdateHook,
  personBirthdayItemUpdateHook,
  sleepItemUpdateHook,
  keepWakeDaysInOnePlan,
  // A task's `hiddenUntil` and `effectiveDate` follow its host Events' dates and times (the task's own `date` is
  // handled by the Tasks transform).
  taskHostEventScheduleItemUpdateHook,
  // A task set to `done` before the end of its last host event is completed in that event; back to `notDone` or
  // `wontDo` removes the edge. After the host-state hooks and the recurrence advance.
  taskCompletedInEventHook,
  sleepResyncUpdateHook,
  // A moved Event queues an updated invitation.
  eventInvitationItemUpdateHook,
  remindersResyncUpdateHook,
  // An open Processing proposals card that refers to an archived project becomes `invalid` in the same transaction.
  proposalReferenceItemUpdateHook,
];

/**
 * Per trashed row of the cascade. The Event lock order (`valueLinkSourceDeleteHook`, then
 * `transcriptCompanyLinkReleaseItemDeleteHook`, then `eventHostedTasksDeleteHook`) is part of the contract.
 */
const itemDeleteHooks: readonly ItemDeleteHook[] = [
  // A user's or agent's trash of an Event in a read-only account calendar is refused before any other hook runs.
  accountCalendarEventDeleteHook,
  nextOccurrenceSeriesItemDeleteHook,
  itemSearchDeleteHook,
  // A user's or agent's trash of a Mailboxes item is refused (only the mailbox removal, as the system writer,
  // trashes it).
  mailboxDeleteHook,
  valueLinkSourceDeleteHook,
  peopleLastContactItemDeleteHook,
  // A transcript's company link ends when its Event is trashed.
  transcriptCompanyLinkReleaseItemDeleteHook,
  // A trashed page takes its subpages and its block in the parent's document with it.
  pageItemDeleteHook,
  // A trashed item of any database but Pages takes its live subpages with it.
  hostItemDeleteHook,
  // A system, subscription or last own calendar cannot be deleted; the default mark moves to another own calendar
  // and the calendar's live Events are trashed with it.
  calendarItemDeleteHook,
  // Trashing an Event returns its hosted tasks to their day (edges stay). After the host-state hooks, which the
  // recomputations use.
  eventHostedTasksDeleteHook,
  // Deleting any instance of a recurring task series trashes the whole series under one `deletedAt`: turns the
  // repeat rule off and records its instance. After the value-link detach, which makes the attachments' links
  // their own.
  taskSeriesItemDeleteHook,
  sleepResyncDeleteHook,
  // A trashed Event queues a cancellation.
  eventInvitationItemDeleteHook,
  transcriptProblemDeleteHook,
  remindersResyncDeleteHook,
  proposalReferenceItemDeleteHook,
];

/** Per restored row of the cascade; a restore sends no invitation. */
const itemRestoreHooks: readonly ItemRestoreHook[] = [
  nextOccurrenceSeriesItemRestoreHook,
  itemSearchRestoreHook,
  transcriptRestoreHook,
  // A restored Journal entry takes its period back, or the restore is refused while another entry holds it.
  journalItemRestoreHook,
  // A restored company feeds the resolver rules like an update of its `web`.
  linkRuleItemRestoreHook,
  peopleLastContactItemRestoreHook,
  pageItemRestoreHook,
  // A restored mailbox without a sync state gets a default one; its folders and messages of its deletion epoch
  // return.
  mailboxItemRestoreHook,
  // Restore brings back the subpages of the item's deletion epoch.
  hostItemRestoreHook,
  // Restore brings back the calendar's Events of its deletion epoch.
  calendarItemRestoreHook,
  // Restoring an Event removes its hosted tasks' edges instead of relinking, locking the tasks first.
  eventHostedTasksRestoreHook,
  // Restoring any instance of a recurring task series restores it and turns the repeat rule back on.
  taskSeriesItemRestoreHook,
  sleepResyncRestoreHook,
  remindersResyncRestoreHook,
  // A Processing proposals card returns to `proposed` when the item it refers to comes back.
  proposalReferenceItemRestoreHook,
];

/** Per row actually removed by the purge. */
const itemPurgeHooks: readonly ItemPurgeHook[] = [
  // Purging a Processing proposals card sweeps the expired stored responses of its card actions.
  idempotentResponsesPurgeHook,
  mailItemPurgeHook,
];

const relationEdgeWriteHooks: readonly RelationEdgeWriteHook[] = [
  transcriptSpeakerEdgeWriteHook,
  threadValueEdgeWriteHook,
  libraryWatchedWithEdgeWriteHook,
  inboxTypeEdgeWriteHook,
  inboxTypeLockWriteHook,
  inboxSourceEdgeWriteHook,
  eventParticipantEdgeWriteHook,
  // A user's or agent's move of an Event into a read-only account calendar.
  accountCalendarEventEdgeWriteHook,
];

const relationEdgeDeleteHooks: readonly RelationEdgeDeleteHook[] = [
  threadValueEdgeDeleteHook,
  inboxTypeEdgeDeleteHook,
  inboxSourceEdgeDeleteHook,
  // A user's or agent's move of an Event out of a read-only account calendar.
  accountCalendarEventEdgeDeleteHook,
];

const relationEdgeChangedHooks: readonly RelationEdgeChangedHook[] = [
  itemSearchEdgeChangedHook,
  inboxTypeLockChangedHook,
  // Removing a `Files.events` edge ends the file's company link. Must precede `linkRuleEdgeHook`: it reads the
  // file's `projects` link, which that hook deletes.
  eventAttachmentLinkReleaseEdgeChangedHook,
  linkRuleEdgeHook,
  // Every change of a thread's company or project (link engine's included) publishes `mailThread`. After
  // `linkRuleEdgeHook`, which queues the rule evaluation that follows the change.
  threadValueEdgeChangedHook,
  peopleLastContactEdgeChangedHook,
  // Removing a transcript's Event edge ends its company link and detaches the Event from the transcript's project
  // and people links.
  transcriptCompanyLinkReleaseEdgeChangedHook,
  // Removing a Tasks `sourceEvents` edge detaches the Event from the task's project and people links of any state.
  // After `linkRuleEdgeHook`, which recomputes the links that are `on`.
  taskSourceEventLinkDetachEdgeChangedHook,
  projectDerivedValueEdgeChangedHook,
  // An item that gets a project loses its own area edge: the area is derived from the project.
  projectAttachmentAreaEdgeChangedHook,
  // Each reported create or delete of an Inbox type edge (a repeated create included) queues the Inbox tick and
  // the recompute of the item's Journal day.
  inboxTypeEdgeChangedHook,
  // A task's `hiddenUntil` and `effectiveDate` follow its host-event edges.
  taskHostEventEdgeChangedHook,
  // Transcripts `event` and Events `people` edge changes queue the speaker suggestion of the affected transcripts.
  // It touches nothing else, so its position does not matter.
  transcriptSpeakerSuggestionEdgeChangedHook,
  threadTaskPeopleEdgeChangedHook,
];

/** A user or agent edge write, before the write ends a value link; lock only. */
const relationEdgeBeforeLinkBreakHooks: readonly RelationEdgeBeforeLinkBreakHook[] = [
  // Takes the item row `linkRuleEdgeHook` locks.
  linkRuleEdgeLockHook,
];

for (const [moduleId, transform, prepare] of itemPreWriteTransforms) {
  registerItemPreWriteTransform(moduleId, transform, prepare);
}
for (const [moduleId, hook] of itemUpdatePreLockHooks) registerItemUpdatePreLockHook(moduleId, hook);
for (const [moduleId, hook] of itemDeletePreLockHooks) registerItemDeletePreLockHook(moduleId, hook);
for (const [moduleId, hook] of itemRestorePreLockHooks) registerItemRestorePreLockHook(moduleId, hook);
for (const [moduleId, hook] of itemPurgePreLockHooks) registerItemPurgePreLockHook(moduleId, hook);
for (const hook of itemCreateHooks) registerItemCreateHook(hook);
for (const hook of itemUpdateHooks) registerItemUpdateHook(hook);
for (const hook of itemDeleteHooks) registerItemDeleteHook(hook);
for (const hook of itemRestoreHooks) registerItemRestoreHook(hook);
for (const hook of itemPurgeHooks) registerItemPurgeHook(hook);
for (const hook of relationEdgeWriteHooks) registerRelationEdgeWriteHook(hook);
for (const hook of relationEdgeDeleteHooks) registerRelationEdgeDeleteHook(hook);
for (const hook of relationEdgeChangedHooks) registerRelationEdgeChangedHook(hook);
for (const hook of relationEdgeBeforeLinkBreakHooks) registerRelationEdgeBeforeLinkBreakHook(hook);

// Module-specific extensions of update, trash and approval: at most one per module.
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
// An agent run's request to trash a Mailboxes item is refused before it is queued for approval.
registerItemDeleteApprovalGuard(MAILBOXES_MODULE_ID, mailboxDeleteApprovalGuard);
registerItemDeleteApprovalGuard(EVENTS_MODULE_ID, accountCalendarEventDeleteApprovalGuard);
// A recurring task's trash covers its whole series; the delete impact reader feeds the delete preview and the
// `item.delete` approval projection.
registerItemCascadeExpansion(TASKS_MODULE_ID, taskSeriesCascadeExpansion);
registerItemDeleteImpactReader(TASKS_MODULE_ID, taskDeleteImpactReader);
registerAutomationBatchReader(readAutomationForItems);

// Read-time registries.
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

registerItemSearchGroup({ type: "task", ownerModuleIds: [TASKS_MODULE_ID] });
registerItemSearchGroup({ type: "event", ownerModuleIds: [EVENTS_MODULE_ID] });
registerItemSearchGroup({ type: "project", ownerModuleIds: [PROJECTS_MODULE_ID] });
registerItemSearchGroup({ type: "area", ownerModuleIds: [AREAS_MODULE_ID] });
registerItemSearchGroup({ type: "contact", ownerModuleIds: [PEOPLE_MODULE_ID, COMPANIES_MODULE_ID] });
registerItemSearchGroup({ type: "journal", ownerModuleIds: [JOURNAL_MODULE_ID] });
registerItemSearchGroup({ type: "file", ownerModuleIds: [FILES_MODULE_ID] });
registerThreadSearchGroup(mailGlobalSearchGroup);
registerThreadSearchGroup(sempThreadSearchGroup);

// A person's related collections list their mail threads under Threads (the People manifest omits the Emails
// collection).
registerRelatedRowContributor(PEOPLE_MODULE_ID, personMailThreadsRelatedRow);

// A downloaded ICS feed becomes the calendar's `subscribedEvents` items. Not a write hook: the feed sweep calls it
// inside its own per-calendar transaction.
registerCalendarFeedConsumer(async (client, feed) => {
  await importSubscribedEvents(client, feed);
});
