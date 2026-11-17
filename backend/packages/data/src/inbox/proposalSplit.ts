import type { PoolClient } from "pg";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { linkSourceInboxRelation } from "./inboxCardSourceLink.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { lockInboxSource } from "./inboxSourceGuard.js";
import { aiProposalPatch, type ProposalEntityKind, type ProposalEnvelope } from "./proposalEnvelope.js";
import { appendHistoryEntry } from "./proposalHistory.js";
import { referencedItemIdsOf } from "./proposalReferences.js";
import { assertValidEnvelopeForCard, lockLiveProposal, type ProposalActionConfig } from "./proposalActions.js";
import { assertCardOfSubject, reviseProposalFromThreadWithClient } from "./proposalThreadRevision.js";

// Splits one Inbox source into several proposal cards from its item thread.

/** Includes the primary card. */
export const MAX_SPLIT_CARDS = 10;

export interface SplitCardInput {
  entityKind: ProposalEntityKind;
  target: string;
  properties: Record<string, unknown>;
}

export interface SplitInboxSourceInput {
  /** The source's primary card; the first entry of `cards` revises it. */
  proposalId: string;
  /** Only a card whose source is this item is split. */
  subjectItemId: string;
  /** Recorded in every card's history. */
  threadId: string;
  messageId: string;
  /** 2 to `MAX_SPLIT_CARDS` entries: the primary card's revision first, then one sibling each. */
  cards: SplitCardInput[];
  message?: string;
  /** A changed primary card is refused, as in a thread revision. */
  ifVersion?: string;
  /** Addresses the realtime invalidation of the writes. */
  actingUserId?: string;
}

export interface SplitInboxSourceResult {
  primary: ItemRow;
  siblings: ItemRow[];
}

/**
 * Splits a card's source Inbox item into `input.cards.length` cards in the caller's transaction, under the primary
 * card's `FOR UPDATE` lock, so at most one split of a card is in flight.
 *
 * Lock order: the card, then the source (`lockInboxSource`, waiting, as confirm does), and only then the card's
 * `sourceInbox` edge `FOR SHARE`. The split never waits for the source while holding the edge, which would deadlock
 * with an association removal (it holds the source, then needs the edge). The tool, which proves the card from the
 * edge first, takes the source before that proof for the same reason.
 *
 * The first entry revises the primary card as a thread revision; others become `proposed` siblings with their own
 * `sourceInbox` edge and `splitFromProposalId`, which the tick never recomputes. All envelopes are validated before
 * the first write; a later failure must roll back the caller's transaction.
 */
export async function splitInboxSourceWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  input: SplitInboxSourceInput,
): Promise<SplitInboxSourceResult> {
  const [first, ...rest] = input.cards;
  if (!first || rest.length === 0) {
    throw new ValidationError("A split needs at least 2 cards", { field: "cards" });
  }
  if (input.cards.length > MAX_SPLIT_CARDS) {
    throw new ValidationError(`A split yields at most ${MAX_SPLIT_CARDS} cards`, { field: "cards" });
  }

  const card = await lockLiveProposal(client, config.processingProposalsDatabaseId, input.proposalId);
  try {
    await lockInboxSource(client, input.subjectItemId);
  } catch (error) {
    // A missing source answers like a card of another item: the same NotFoundError as a missing card.
    if (error instanceof NotFoundError) throw new NotFoundError(`Processing proposal ${card.id} not found`);
    throw error;
  }
  await assertCardOfSubject(client, config, card, input.subjectItemId);
  if (typeof card.properties.splitFromProposalId === "string") {
    throw new ValidationError("A sibling card cannot be split; split the source's primary card", {
      field: "proposalId",
    });
  }
  const siblingEnvelopes: ProposalEnvelope[] = rest.map(({ entityKind, target, properties }) => ({
    entityKind,
    target,
    properties,
  }));
  for (const envelope of siblingEnvelopes) await assertValidEnvelopeForCard(client, config, card, envelope);

  const primary = await reviseProposalFromThreadWithClient(client, config, {
    proposalId: card.id,
    subjectItemId: input.subjectItemId,
    threadId: input.threadId,
    messageId: input.messageId,
    entityKind: first.entityKind,
    target: first.target,
    properties: first.properties,
    message: input.message ?? `Split the source into ${input.cards.length} cards.`,
    ...(input.ifVersion === undefined ? {} : { ifVersion: input.ifVersion }),
    ...(input.actingUserId === undefined ? {} : { actingUserId: input.actingUserId }),
  });
  publishInboxCardChange(client, primary.id, "updated");

  const siblings: ItemRow[] = [];
  for (const envelope of siblingEnvelopes) {
    const sibling = await createItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        properties: {
          kind: "inbox",
          proposal: envelope,
          ...aiProposalPatch({}, envelope),
          referencedItemIds: referencedItemIdsOf(envelope),
          history: appendHistoryEntry([], input.message ?? "Created by splitting the source.", "ai", {
            kind: "threadRevision",
            threadId: input.threadId,
            messageId: input.messageId,
          }),
          status: "proposed",
          splitFromProposalId: primary.id,
        },
      },
      {
        allowedSystemKeys: [
          "kind",
          "proposal",
          "aiProposal",
          "aiVersion",
          "referencedItemIds",
          "history",
          "status",
          "splitFromProposalId",
        ],
        ...(input.actingUserId === undefined ? {} : { actingUserId: input.actingUserId }),
      },
    );
    await linkSourceInboxRelation(client, config, sibling.id, input.subjectItemId);
    publishInboxCardChange(client, sibling.id, "created");
    siblings.push(sibling);
  }
  return { primary, siblings };
}
