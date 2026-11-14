import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { listInboxAttachments } from "./inboxAttachmentsStore.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { lockLiveProposal, reviseProposalFromThreadWithClient } from "./proposalActions.js";
import { parseStoredProposalEnvelope, proposalEnvelopeSchema } from "./proposalEnvelope.js";
import { proposalHistoryEntrySchema } from "./proposalHistory.js";
import { lockInboxSource } from "./inboxSourceGuard.js";
import { MAX_SPLIT_CARDS, splitInboxSourceWithClient } from "./proposalSplit.js";
import { containsNul, MAX_REVISE_MESSAGE_LENGTH } from "./reviseInputChecks.js";

// The prompt context of a thread turn on an Inbox item (issue #1938) is exported here, because `index.ts` exports this
// file whole and has no line left under the ESLint line cap for another export.
export { loadInboxCardThreadContext, renderInboxCardThreadContext } from "./threadCardContext.js";

export const inboxProposalGetArgsSchema = z.object({ proposalId: z.string().uuid() }).strict();
const notFound = { error: true, result: "Proposal not found" } as const;
const NOT_IN_RUNNING_REPLY = "The call is not part of a running Semp reply";
const sourceSchema = z.object({ text: z.string().nullable().optional() }).passthrough();
const cardSchema = z
  .object({
    status: z.string(),
    userEditedKeys: z.array(z.string()).nullable().optional(),
    history: z.unknown().optional(),
    proposal: z.unknown().optional(),
  })
  .passthrough();

/**
 * The card of the calling run's own Inbox item thread that `proposalId` names, with the ids the revise tool records:
 * the run's persisted `thread_id`, the thread's source Inbox item and, from the same run, the actor. It answers
 * `null` for a run that is not in a live item thread, and for every card that is not linked to that thread's source
 * by the current `sourceInbox` edge. A thread's stored `subject_proposal_id` is only a hint and never decides.
 * With `lockEdge` the edge row is read `FOR SHARE`, so an edge removal waits for the transaction that passed the
 * check and a removal already committed is seen.
 */
async function findOwnThreadCard(
  client: PoolClient,
  runId: string,
  proposalId: string,
  lockEdge: boolean,
): Promise<{ sourceId: string; cardId: string; threadId: string; actorUserId: string } | null> {
  const association = await client.query<{
    source_id: string;
    card_id: string;
    thread_id: string;
    actor_user_id: string;
  }>(
    `SELECT source.id AS source_id, card.id AS card_id, thread.id AS thread_id, run.actor_user_id
           FROM agent_runs run
           JOIN semp_threads thread ON thread.tenant_id = run.tenant_id AND thread.id = run.thread_id AND thread.kind = 'item'
           JOIN items source ON source.tenant_id = thread.tenant_id AND source.id = thread.subject_inbox_item_id AND source.deleted_at IS NULL
           JOIN databases inbox ON inbox.tenant_id = source.tenant_id AND inbox.id = source.database_id AND inbox.owner_module_id = 'inbox'
           JOIN items card ON card.tenant_id = source.tenant_id AND card.id = $2 AND card.deleted_at IS NULL
           JOIN databases proposals ON proposals.tenant_id = card.tenant_id AND proposals.id = card.database_id AND proposals.owner_module_id = 'processingProposals'
           JOIN properties property ON property.tenant_id = proposals.tenant_id AND property.database_id = proposals.id AND property.key = 'sourceInbox'
           JOIN relation_definitions definition ON definition.tenant_id = property.tenant_id AND (definition.property_id_a = property.id OR definition.property_id_b = property.id)
           JOIN item_relations edge ON edge.tenant_id = definition.tenant_id AND edge.relation_definition_id = definition.id
             AND ((edge.item_a = source.id AND edge.item_b = card.id) OR (edge.item_b = source.id AND edge.item_a = card.id))
          WHERE run.tenant_id = app_current_tenant() AND run.id = $1${lockEdge ? "\n          FOR SHARE OF edge" : ""}`,
    [runId, proposalId],
  );
  const row = association.rows[0];
  return row
    ? { sourceId: row.source_id, cardId: row.card_id, threadId: row.thread_id, actorUserId: row.actor_user_id }
    : null;
}

/** Read only the live card associated with the calling run's current Inbox thread. */
export function createInboxProposalGetTool(pool: Pool) {
  return async (runId: string, rawArgs: unknown): Promise<{ error: boolean; result: string }> => {
    const args = inboxProposalGetArgsSchema.safeParse(rawArgs);
    if (!args.success) return { error: true, result: "Invalid arguments" };
    if (!z.string().uuid().safeParse(runId).success || currentTenantScope()?.kind !== "tenant") return notFound;
    return withTransaction(pool, async (client) => {
      const row = await findOwnThreadCard(client, runId, args.data.proposalId, false);
      if (!row) return notFound;
      const items = await getItemsByIds(client, [row.sourceId, row.cardId]);
      const source = items.find((item) => item.id === row.sourceId);
      const card = items.find((item) => item.id === row.cardId);
      if (!source || !card) return notFound;
      const sourceProperties = sourceSchema.parse(source.properties);
      const cardProperties = cardSchema.parse(card.properties);
      const attachments = await listInboxAttachments(client, [source.id]);
      const history = z.array(proposalHistoryEntrySchema).safeParse(cardProperties.history);
      return {
        error: false,
        result: JSON.stringify({
          captureText: sourceProperties.text ?? null,
          attachments: attachments.map((attachment) => ({ attachmentId: attachment.attachmentId, name: null })),
          envelope: parseStoredProposalEnvelope(cardProperties.proposal, card.id),
          userEditedKeys: cardProperties.userEditedKeys ?? [],
          version: card.updatedAt,
          status: cardProperties.status,
          history: history.success ? history.data : [],
        }),
      };
    });
  };
}

/**
 * The arguments of `inbox.proposal.revise`: the card, the version of the card the revision was composed from, the
 * whole revised envelope and an optional note for the card's history. `entityKind` and `target` default to those of
 * the card's current proposal, so a revision that keeps the destination names only the new `properties`. The thread
 * and the message the revision is recorded under are never arguments: the tool reads them from the run. `ifVersion`
 * is the `version` the card context or `inbox.proposal.get` showed: the model composes the whole envelope from that
 * snapshot, so a card the user edited since is refused instead of being overwritten with the stale values.
 */
export const inboxProposalReviseArgsSchema = z
  .object({
    proposalId: z.string().uuid(),
    entityKind: proposalEnvelopeSchema.shape.entityKind.optional(),
    target: z.string().min(1).optional(),
    ifVersion: z
      .string()
      .min(1)
      .describe(
        "The `version` of the card that you composed this revision from, copied from the card context or from inbox.proposal.get. A card that was changed since is refused.",
      ),
    properties: z
      .record(z.string(), z.unknown())
      .describe(
        "The properties of the whole revised envelope: every property of the card's effective envelope, with the changes the instruction asks for. A property you leave out is not removed; write null to clear one.",
      ),
    message: z.string().min(1).max(MAX_REVISE_MESSAGE_LENGTH).optional(),
  })
  .strict();

/**
 * The id of the assistant message of the thread that is running this run's turn (the latest one, should more than
 * one be running), or `null` when the call is not part of a running reply. The tools that write on behalf of a thread
 * record it in the history of the cards they change.
 */
async function findRunningReplyMessageId(client: PoolClient, runId: string, threadId: string): Promise<string | null> {
  const running = await client.query<{ id: string }>(
    `SELECT id FROM semp_messages
      WHERE tenant_id = app_current_tenant() AND agent_run_id = $1 AND thread_id = $2
        AND role = 'assistant' AND status = 'running'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [runId, threadId],
  );
  return running.rows[0]?.id ?? null;
}

/** The error result of a refusal the model can act on: the status the route would answer, its code, message and field. */
function refusal(error: ChokePointError): { error: true; result: string } {
  const field =
    typeof error.details === "object" && error.details !== null && "field" in error.details
      ? error.details.field
      : undefined;
  return {
    error: true,
    result: JSON.stringify({
      status: error.status,
      error: error.code,
      message: error.message,
      ...(typeof field === "string" ? { field } : {}),
    }),
  };
}

/**
 * `inbox.proposal.revise` (issues #1906 and #1938): the assistant of an Inbox item thread replaces the envelope of
 * that thread's own card with a revised one, through `reviseProposalFromThreadWithClient`: the envelope is validated
 * as the revise route validates it, and the user's manual values follow the rules of a thread revision. The tool never
 * writes to the target database: the card stays a proposal and only the user's confirm creates anything.
 *
 * Only the card of the calling run's own item thread is revised. Any other id, whether it belongs to another card, to
 * another tenant or to nothing, gets the answer of the read tool, so the answer does not tell whether the card
 * exists. The thread id comes from the run and the message id from the assistant message of the thread that is
 * running this run's turn (the latest one, should more than one be running), never from the arguments. A card that is
 * `confirmed` or `rejected` and an invalid envelope give an error result and write nothing, and so does a card that
 * changed since the `ifVersion` the call names (`version_conflict`: the model reads the card again). After a successful
 * revision the card's invalidation is published once the transaction has committed. The result states the success for
 * the step of the reply and carries the card's new `version`, which a second revision of the same turn passes.
 *
 * Lock order (`docs/adr/2026-11-13-an-item-thread-tool-proves-its-card-with-a-shared-lock-on-its-source-edge.md`):
 * the card `FOR UPDATE`, then the card's `sourceInbox` edge `FOR SHARE`; the tool never locks the source.
 */
export function createInboxProposalReviseTool(pool: Pool) {
  return async (runId: string, rawArgs: unknown): Promise<{ error: boolean; result: string }> => {
    const parsed = inboxProposalReviseArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: true, result: "Invalid arguments" };
    const args = parsed.data;
    if (!z.string().uuid().safeParse(runId).success || currentTenantScope()?.kind !== "tenant") return notFound;
    for (const field of ["properties", "target", "message"] as const) {
      if (containsNul(args[field])) {
        return refusal(new ValidationError(`'${field}' must not contain NUL characters`, { field }));
      }
    }
    try {
      return await withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
        if (!database) return notFound;
        const config = { processingProposalsDatabaseId: database.id };
        let card: Awaited<ReturnType<typeof lockLiveProposal>>;
        try {
          card = await lockLiveProposal(client, database.id, args.proposalId);
        } catch (error) {
          if (error instanceof NotFoundError) return notFound;
          throw error;
        }
        const own = await findOwnThreadCard(client, runId, card.id, true);
        if (!own) return notFound;
        const messageId = await findRunningReplyMessageId(client, runId, own.threadId);
        if (!messageId) return { error: true, result: NOT_IN_RUNNING_REPLY };
        const revised = await reviseProposalFromThreadWithClient(client, config, {
          proposalId: card.id,
          subjectItemId: own.sourceId,
          threadId: own.threadId,
          messageId,
          ...(args.entityKind === undefined ? {} : { entityKind: args.entityKind }),
          ...(args.target === undefined ? {} : { target: args.target }),
          properties: args.properties,
          ifVersion: args.ifVersion,
          ...(args.message === undefined ? {} : { message: args.message }),
          actingUserId: own.actorUserId,
        });
        publishInboxCardChange(client, revised.id, "updated");
        return {
          error: false,
          result: JSON.stringify({ proposalId: revised.id, revised: true, version: revised.updatedAt }),
        };
      });
    } catch (error) {
      if (error instanceof ChokePointError) return refusal(error);
      throw error;
    }
  };
}

/**
 * `findOwnThreadCard` for a caller that holds the card and needs the source row: the thread's source is read from an
 * unlocked association, locked `FOR UPDATE` (waiting, as confirm does after its card), and the association is then read
 * again with the edge `FOR SHARE`, so the edge is never held while the source is waited for. `null` when the card is
 * not the thread's own, as for `findOwnThreadCard`, including a source or an association that went away meanwhile.
 */
async function provedOwnCardUnderSource(client: PoolClient, runId: string, cardId: string) {
  const hinted = await findOwnThreadCard(client, runId, cardId, false);
  if (!hinted) return null;
  try {
    await lockInboxSource(client, hinted.sourceId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  const own = await findOwnThreadCard(client, runId, cardId, true);
  return own && own.sourceId === hinted.sourceId ? own : null;
}

/**
 * The arguments of `inbox.proposal.split`: the card to split, the version of the card the split was composed from and
 * the cards the source becomes, the first of which revises that card and the others become siblings of it. The thread
 * and the message the split is recorded under are never arguments: the tool reads them from the run. `ifVersion` is the
 * `version` the card context or `inbox.proposal.get` showed, as for `inbox.proposal.revise`: the first entry replaces
 * the card's whole envelope, so a card the user edited since is refused instead of being overwritten.
 */
export const inboxProposalSplitArgsSchema = z
  .object({
    proposalId: z.string().uuid(),
    ifVersion: z
      .string()
      .min(1)
      .describe(
        "The `version` of the card that you composed this split from, copied from the card context or from inbox.proposal.get. A card that was changed since is refused.",
      ),
    cards: z
      .array(
        z
          .object({
            entityKind: proposalEnvelopeSchema.shape.entityKind,
            target: z.string().min(1),
            properties: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_SPLIT_CARDS)
      .describe(
        `Between 2 and ${MAX_SPLIT_CARDS} cards. The first entry replaces the envelope of the card proposalId, which stays the source's main card; every other entry becomes a new card of the same source. Each entry is a whole envelope.`,
      ),
    message: z.string().min(1).max(MAX_REVISE_MESSAGE_LENGTH).optional(),
  })
  .strict();

/**
 * `inbox.proposal.split` (issue #1939): the assistant of an Inbox item thread splits that thread's source into several
 * proposal cards, through `splitInboxSourceWithClient` in one transaction. The first entry revises the thread's own
 * card and the others become sibling cards of the same source, which the tick never recomputes. The tool never writes to
 * a target database: every card stays a proposal and only the user's confirm creates anything.
 *
 * The own-card proof, the answer for any other card and the source of the thread id and the running assistant message
 * are those of `inbox.proposal.revise` (`createInboxProposalReviseTool`), never the arguments, with one difference in
 * the locks: the split needs the source row (it links its siblings to it), so the tool locks the card `FOR UPDATE`,
 * reads the card's association without a lock, locks the source `FOR UPDATE` and only then takes the edge `FOR SHARE`
 * (`provedOwnCardUnderSource`). Order and reason: `docs/adr/2026-11-14-a-source-split-locks-the-card-then-the-source-then-the-source-edge.md`;
 * the order of `docs/adr/2026-11-13-an-item-thread-tool-proves-its-card-with-a-shared-lock-on-its-source-edge.md` is
 * for a tool that never locks the source. A card that is
 * `confirmed` or `rejected`, a card that is itself a sibling, an invalid envelope in any entry and a card changed
 * since `ifVersion` give an error result and write nothing. The card changes are announced by the action after the
 * transaction commits, and the result lists the ids of the cards and the primary card's new `version`.
 */
export function createInboxProposalSplitTool(pool: Pool) {
  return async (runId: string, rawArgs: unknown): Promise<{ error: boolean; result: string }> => {
    const parsed = inboxProposalSplitArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: true, result: "Invalid arguments" };
    const args = parsed.data;
    if (!z.string().uuid().safeParse(runId).success || currentTenantScope()?.kind !== "tenant") return notFound;
    if (containsNul(args.cards) || containsNul(args.message)) {
      return refusal(new ValidationError("'cards' and 'message' must not contain NUL characters", { field: "cards" }));
    }
    try {
      return await withTransaction(pool, async (client) => {
        const database = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
        if (!database) return notFound;
        const config = { processingProposalsDatabaseId: database.id };
        let card: Awaited<ReturnType<typeof lockLiveProposal>>;
        try {
          card = await lockLiveProposal(client, database.id, args.proposalId);
        } catch (error) {
          if (error instanceof NotFoundError) return notFound;
          throw error;
        }
        const own = await provedOwnCardUnderSource(client, runId, card.id);
        if (!own) return notFound;
        const messageId = await findRunningReplyMessageId(client, runId, own.threadId);
        if (!messageId) return { error: true, result: NOT_IN_RUNNING_REPLY };
        const split = await splitInboxSourceWithClient(client, config, {
          proposalId: card.id,
          subjectItemId: own.sourceId,
          threadId: own.threadId,
          messageId,
          cards: args.cards,
          ifVersion: args.ifVersion,
          ...(args.message === undefined ? {} : { message: args.message }),
          actingUserId: own.actorUserId,
        });
        return {
          error: false,
          result: JSON.stringify({
            proposalId: split.primary.id,
            siblingProposalIds: split.siblings.map((sibling) => sibling.id),
            split: true,
            version: split.primary.updatedAt,
          }),
        };
      });
    } catch (error) {
      if (error instanceof ChokePointError) return refusal(error);
      throw error;
    }
  };
}
