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
import { BOOKS_MODULE_ID } from "./seed/libraryModuleKeys.js";
import {
  mailboxConnectionLimitCreateHook,
  mailboxConnectionLimitUpdateHook,
} from "./mail/mailboxConnectionLimitHook.js";
import { sanitizeMailHtml } from "./mail/htmlSanitize.js";
import { EMAILS_MODULE_ID } from "./seed/emailModuleKeys.js";
import { registerItemReadProjection } from "./chokePoint/hooks.js";
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
  registerRelationEdgeWriteHook,
  registerRelationEdgeDeleteHook,
  registerRelationEdgeChangedHook,
  registerAutomationBatchReader,
  registerItemRestoreHook,
  registerItemDeleteHook,
  registerItemPurgeHook,
} from "./chokePoint/hooks.js";
import { readAutomationForItems } from "./library/itemAutomationStore.js";
import { linkRuleItemHook } from "./valueLinks/linkRuleItemHook.js";
import { linkRuleEdgeHook } from "./valueLinks/linkRuleEdgeHook.js";
import { valueLinkSourceDeleteHook } from "./valueLinks/valueLinkSourceDeleteHook.js";
import { mcpServerItemCreateHook, mcpServerItemUpdateHook } from "./mcp/mcpServerWriteHook.js";
import { recipePhotoWriteHook } from "./recipes/recipePhotoHook.js";
import { mailMessageFlagsItemUpdateHook } from "./mail/mailMessageFlagSyncStore.js";
import { mailItemPurgeHook } from "./mail/mailPurgeHook.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID, TASKS_MODULE_ID, PROJECTS_MODULE_ID } from "./seed/tenDatabaseKeys.js";
import { eventTimePreWriteTransform, prepareEventTime } from "./calendar/eventTime.js";
import { eventIcalIdentityTransform, prepareEventIcalIdentity } from "./calendar/eventIcalIdentityTransform.js";
import { eventValidationItemCreateHook, eventValidationItemUpdateHook } from "./calendar/eventValidationHook.js";
import {
  eventReminderValuesItemCreateHook,
  eventReminderValuesItemUpdateHook,
} from "./calendar/eventReminderValuesHook.js";
import { taskRecurrenceItemUpdateHook } from "./tasks/taskRecurrenceItemUpdateHook.js";
import { prepareTaskProposal, taskPreWriteTransform } from "./tasks/taskPreWriteTransform.js";
import { threadValueEdgeDeleteHook, threadValueEdgeWriteHook } from "./mail/threadValueEdges.js";
import { transcriptSpeakerEdgeWriteHook } from "./transcription/transcriptionSpeakerEdges.js";
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
registerItemPreWriteTransform(PROJECTS_MODULE_ID, projectWriteTransform, prepareProjectWrite);
registerItemPreWriteTransform(FILES_MODULE_ID, filesItemPreWriteTransform, async ({ stored, patch }) => ({
  patch,
  deferredKeys: stored === null && !Object.hasOwn(patch, "type") && Object.hasOwn(patch, "file") ? ["type"] : [],
}));
// Events: the time transform first, so the iCalendar sequence compares normalized times (issues #1598, #1599).
registerItemPreWriteTransform(EVENTS_MODULE_ID, eventTimePreWriteTransform, prepareEventTime);
registerItemPreWriteTransform(EVENTS_MODULE_ID, eventIcalIdentityTransform, prepareEventIcalIdentity);
// Events: the date and time rules judge what the transforms above stored (issue #1663).
registerItemCreateHook(eventValidationItemCreateHook);
registerItemUpdateHook(eventValidationItemUpdateHook);
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
// Issue gh-1691: the mail rows of a permanently deleted Emails or Mailboxes item go with it.
registerItemPurgeHook(mailItemPurgeHook);

registerItemCreateHook(areaItemCreateHook);
registerItemUpdateHook(areaItemUpdateHook);

registerItemUpdateHook(linkRuleItemHook);
registerRelationEdgeChangedHook(linkRuleEdgeHook);
registerItemDeleteHook(valueLinkSourceDeleteHook);
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

// Issue #1710: a project's area or company edge change queues the announcement of the project's items.
registerRelationEdgeChangedHook(projectDerivedValueEdgeChangedHook);

// Events: a write that names `alertMinutes` or `travelMinutes` gives an allowed value or `null` (issue #1714).
registerItemCreateHook(eventReminderValuesItemCreateHook);
registerItemUpdateHook(eventReminderValuesItemUpdateHook);

// Issue #1718: each reported `create` or `delete` of an Inbox type edge, a repeated create of an existing edge
// included, queues the Inbox tick and the recompute of the item's Journal day.
registerRelationEdgeChangedHook(inboxTypeEdgeChangedHook);
