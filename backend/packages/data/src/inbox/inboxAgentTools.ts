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

// Re-exported here because `index.ts` exports this file whole and has no line left under the ESLint line cap.
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
 * `null` unless the card is linked by the current `sourceInbox` edge to the source of the run's live item thread; the
 * thread's stored `subject_proposal_id` is only a hint. With `lockEdge` the edge is read `FOR SHARE`, so a concurrent
 * edge removal waits for this transaction and an already committed removal is seen.
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
 * `entityKind` and `target` default to the card's current proposal. Thread and message come from the run, never from
 * arguments. `ifVersion` is the version the model composed the whole envelope from, so a card the user edited since is
 * refused instead of overwritten with stale values.
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

/** The latest running assistant message of the thread for this run, or `null` outside a running reply. */
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
 * Revises the envelope of the run's own item-thread card. Never writes to the target database: only the user's
 * confirm creates anything.
 *
 * Any other id (another card, another tenant, nothing) gets the read tool's answer, so existence is not leaked.
 * Confirmed/rejected cards, invalid envelopes and `version_conflict` write nothing. The card invalidation is
 * published after commit; the result carries the new `version` for a second revision in the same turn.
 *
 * Lock order: the card `FOR UPDATE`, then its `sourceInbox` edge `FOR SHARE`; the source is never locked.
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
 * Reads the association unlocked, locks the source `FOR UPDATE` (as confirm does after its card), then re-reads the
 * association with the edge `FOR SHARE`, so the edge is never held while waiting for the source. `null` also when the
 * source or association went away meanwhile.
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
 * The first entry revises the card, the others become its siblings. `ifVersion` works as for `inbox.proposal.revise`.
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
 * Splits the thread's source into several cards in one transaction; siblings are never recomputed by the tick. Never
 * writes to a target database.
 *
 * Own-card proof and answers as for `inbox.proposal.revise`, but the split needs the source row to link siblings, so
 * the lock order is card `FOR UPDATE`, source `FOR UPDATE`, then edge `FOR SHARE` (`provedOwnCardUnderSource`). A
 * sibling card cannot be split. Card changes are announced after commit.
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
