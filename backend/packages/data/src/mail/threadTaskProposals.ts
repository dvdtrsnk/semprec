// Semp never creates a thread's task itself: it proposes one as a Processing proposals card of kind
// `mailThread` linked through `sourceThread`, and the user's confirm creates the task. This module writes only
// the card and its edge.
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

/** The only status the duplicate rule looks at. */
const PROPOSED_STATUS = "proposed";

const SOURCE_THREAD_PROPERTY_KEY = "sourceThread";

/** The Processing proposals module owns the `sourceThread` relation. */
const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

/** A generic item write cannot set these; the producer's create can. */
const CARD_SYSTEM_KEYS = ["kind", "proposal", "aiProposal", "aiVersion", "history", "status"];

const UNPAIRED_SURROGATE = /\p{Cs}/u;

/** Same bounds as the thread task route, and storable in `jsonb` (no U+0000, no unpaired surrogate). */
export const threadTaskProposalNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(THREAD_TASK_NAME_MAX_LENGTH)
  .refine((value) => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value), {
    message: "The name must not contain U+0000 or an unpaired surrogate",
  });

export interface ThreadTaskProposalInput {
  /** May be a thread a merge absorbed. */
  threadId: string;
  name: string;
}

export interface ThreadTaskProposal {
  proposalId: string;
  status: typeof PROPOSED_STATUS;
}

const storedCardSchema = z.looseObject({
  kind: z.literal(MAIL_THREAD_CARD_KIND),
  status: z.literal(PROPOSED_STATUS),
  proposal: z.looseObject({ properties: z.looseObject({ name: z.string() }) }),
});

/** Trimmed and case folded, so "Call Jana" and " call jana " are one name. */
function comparableName(name: string): string {
  return name.trim().toLowerCase();
}

/** Reads the card's current `proposal` (which the user may have edited), not the assistant's first output. */
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

/** A latest message without a subject resolves to the empty string, which counts as no subject. */
function historyMessage(name: string, subject: string | null): string {
  return subject === null || subject.trim() === ""
    ? `Proposed the task "${name}" from a mail thread.`
    : `Proposed the task "${name}" from the mail thread "${subject}".`;
}

/**
 * Starts with the tenant's mail-thread guard (merged ids resolved; unknown and foreign ids are the same
 * `NotFoundError`), then locks the Threads item `FOR NO KEY UPDATE`; a trashed one is `NotFoundError` because its card
 * could not be confirmed.
 *
 * Under that lock an existing live `proposed` card with the same name is returned and nothing is written.
 * Otherwise one card and its `sourceThread` edge are created as a system write, because the tool's capability
 * grants no write access to Processing proposals. Confirmed, rejected or trashed cards are no duplicates.
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
