// Issue gh-2035: the card that `mail.thread.proposeTask` writes. Semp never creates a task of a thread itself: it
// proposes one in the Inbox, as a Processing proposals card of kind `mailThread` linked to the thread's Threads item
// through `sourceThread`, and the user's confirm of that card creates the task (`inbox/mailThreadCard.ts`, issue
// gh-2034). This module writes the card and its edge and nothing else: no Tasks item and no `Threads.tasks` edge.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md,
// docs/adr/2026-11-14-mail-thread-cards-are-produced-by-the-mail-module-when-semp-proposes-a-task.md
import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { NotFoundError } from "../errors.js";
import { publishInboxCardChange } from "../inbox/inboxCardsRealtime.js";
import { aiProposalPatch, appendHistoryEntry, assertValidProposalEnvelope } from "../inbox/inboxTickAction.js";
import { MAIL_THREAD_CARD_KIND } from "../inbox/mailThreadCard.js";
import type { ProposalEnvelope } from "../inbox/proposalEnvelope.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { resolveMailThreadForAction } from "./mailThreadActions.js";
import { getMailThreadItemId } from "./mailMessageMetaStore.js";
import { resolveMailThreadRefTargets } from "./mailThreadRef.js";
import { THREAD_TASK_NAME_MAX_LENGTH } from "./threadTasks.js";

/** The status of a card that waits for the user's decision; the only status the duplicate rule looks at. */
const PROPOSED_STATUS = "proposed";

/** The relation property from a `mailThread` card to its Threads item, as `seed/seedInboxPipeline.ts` creates it. */
const SOURCE_THREAD_PROPERTY_KEY = "sourceThread";

/** The context a card's `sourceThread` edge is written under: the Processing proposals module owns that relation. */
const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

/** The system-owned properties the card is created with; a generic item write cannot set them, the producer's create can. */
const CARD_SYSTEM_KEYS = ["kind", "proposal", "aiProposal", "aiVersion", "history", "status"];

/** An unpaired surrogate (Cs), which `jsonb` refuses. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/**
 * The name of the proposed task: trimmed, 1 to 500 characters (the bounds of the route that creates a thread task,
 * `THREAD_TASK_NAME_MAX_LENGTH`) and storable in a `jsonb` value, which refuses U+0000 and an unpaired surrogate.
 */
export const threadTaskProposalNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(THREAD_TASK_NAME_MAX_LENGTH)
  .refine((value) => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value), {
    message: "The name must not contain U+0000 or an unpaired surrogate",
  });

export interface ThreadTaskProposalInput {
  /** The id of a mail thread, or of one that a merge absorbed. */
  threadId: string;
  /** The task's name, as `threadTaskProposalNameSchema` parsed it. */
  name: string;
}

export interface ThreadTaskProposal {
  /** The id of the Processing proposals card. */
  proposalId: string;
  status: typeof PROPOSED_STATUS;
}

/** The part of a stored card that the duplicate rule reads. Anything else about a card is not its concern. */
const storedCardSchema = z.looseObject({
  kind: z.literal(MAIL_THREAD_CARD_KIND),
  status: z.literal(PROPOSED_STATUS),
  proposal: z.looseObject({ properties: z.looseObject({ name: z.string() }) }),
});

/** The comparison form of a name: trimmed and case folded, so that "Call Jana" and " call jana " are one name. */
function comparableName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The oldest live `proposed` card of kind `mailThread` that is linked to the Threads item `threadItemId` and whose
 * current envelope names the task `name` (compared after trimming and case folding), or `null`. The envelope read is
 * the card's own `proposal`, the one the Inbox shows and the user may have edited, not the assistant's first output.
 */
async function findProposedCardNamed(
  client: PoolClient,
  sourceThreadDefinitionId: string,
  threadItemId: string,
  name: string,
): Promise<ItemRow | null> {
  const edges = await relationsStore.listRelationsForItem(client, sourceThreadDefinitionId, threadItemId);
  const cards = await itemsStore.getItemsByIds(
    client,
    edges.map((edge) => relationsStore.otherSide(edge, threadItemId)),
  );
  const wanted = comparableName(name);
  const matching = cards.filter((card) => {
    const stored = storedCardSchema.safeParse(card.properties);
    return stored.success && comparableName(stored.data.proposal.properties.name) === wanted;
  });
  matching.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return matching[0] ?? null;
}

/**
 * The history entry of a new card: names the task and, when the thread has one, its subject. A blank subject (a latest
 * message without one resolves to the empty string, not to `null`) is no subject.
 */
function historyMessage(name: string, subject: string | null): string {
  return subject === null || subject.trim() === ""
    ? `Proposed the task "${name}" from a mail thread.`
    : `Proposed the task "${name}" from the mail thread "${subject}".`;
}

/**
 * Proposes the task `input.name` for the mail thread `input.threadId` in the caller's READ COMMITTED tenant transaction
 * (issue gh-2035) and returns the card's id with its status `proposed`. The transaction starts with the tenant's
 * mail-thread guard (`resolveMailThreadForAction`), which resolves the id of a merged-away thread to the thread that
 * absorbed it and throws the same `NotFoundError` for an unknown id and another tenant's id. The thread's Threads item is
 * then locked `FOR UPDATE`; one in the Trash is the same `NotFoundError`, because a card of it could not be confirmed.
 *
 * Under that lock, a live `proposed` card of kind `mailThread` that the thread already has with the same name (after
 * trimming and case folding) is returned and nothing is written. Otherwise one card is created: kind `mailThread`,
 * status `proposed`, the envelope `{ entityKind: "database", target: <Tasks database id>, properties: { name } }`
 * validated by `assertValidProposalEnvelope` and stored as `proposal` and as the assistant's `aiProposal`, and a history
 * entry authored by the AI that names the thread's subject, and then its `sourceThread` edge to the thread's Threads
 * item. The card is a system write, as the transcription worker's cards are, because the tool's capability grants no
 * write access to Processing proposals. No Tasks item and no `Threads.tasks` edge is written: the confirm of the card
 * (`confirmMailThreadCard`) creates the task. A card of the same name that is `confirmed`, `rejected` or in the Trash is
 * not a duplicate, so the same task may be proposed for the thread again.
 */
export async function proposeThreadTask(
  client: PoolClient,
  input: ThreadTaskProposalInput,
): Promise<ThreadTaskProposal> {
  const threadId = await resolveMailThreadForAction(client, input.threadId);
  const threadItemId = await getMailThreadItemId(client, threadId);
  const threads = await databasesStore.getDatabaseByModuleId(client, THREADS_MODULE_ID);
  const tasks = await databasesStore.getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const proposals = await databasesStore.getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  if (!threads || !tasks || !proposals)
    throw new Error("The Threads, Tasks or Processing proposals database is not seeded");
  const sourceThread = await propertiesStore.getPropertyByKey(client, proposals.id, SOURCE_THREAD_PROPERTY_KEY);
  const definition = sourceThread
    ? await relationsStore.getRelationDefinitionByPropertyId(client, sourceThread.id)
    : null;
  if (!sourceThread || !definition) throw new Error("Processing proposals has no sourceThread relation");

  const threadItem = await itemsStore.lockItemById(client, threads.id, threadItemId);
  if (!threadItem || threadItem.deletedAt) throw new NotFoundError("Thread not found");

  const existing = await findProposedCardNamed(client, definition.id, threadItemId, input.name);
  if (existing) return { proposalId: existing.id, status: PROPOSED_STATUS };

  const envelope: ProposalEnvelope = {
    entityKind: "database",
    target: tasks.id,
    properties: { name: input.name },
  };
  await assertValidProposalEnvelope(client, envelope);
  const [target] = await resolveMailThreadRefTargets(client, [threadId]);
  const card = await createItemWithClient(
    client,
    {
      databaseId: proposals.id,
      properties: {
        kind: MAIL_THREAD_CARD_KIND,
        proposal: envelope,
        ...aiProposalPatch({}, envelope),
        history: appendHistoryEntry([], historyMessage(input.name, target?.label ?? null)),
        status: PROPOSED_STATUS,
      },
    },
    { allowedSystemKeys: CARD_SYSTEM_KEYS },
  );
  await createRelationWithClient(
    client,
    { relationPropertyId: sourceThread.id, callerItemId: card.id, targetItemId: threadItemId },
    PROCESSING_PROPOSALS_RELATION_CONTEXT,
  );
  publishInboxCardChange(client, card.id, "created");
  return { proposalId: card.id, status: PROPOSED_STATUS };
}
