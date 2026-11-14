import type { PoolClient } from "pg";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { linkSourceInboxRelation } from "./inboxCardSourceLink.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { lockInboxSource } from "./inboxSourceGuard.js";
import { aiProposalPatch, type ProposalEntityKind, type ProposalEnvelope } from "./proposalEnvelope.js";
import { appendHistoryEntry } from "./proposalHistory.js";
import { assertValidEnvelopeForCard, lockLiveProposal, type ProposalActionConfig } from "./proposalActions.js";
import { assertCardOfSubject, reviseProposalFromThreadWithClient } from "./proposalThreadRevision.js";

/**
 * Splitting one Inbox source into several proposal cards from its item thread (issue #1939), as decided in
 * `docs/adr/2026-10-25-thread-may-split-an-inbox-source.md`.
 */

/** The most cards one split yields, the primary card included (the ADR's limit). */
export const MAX_SPLIT_CARDS = 10;

/** The destination and values of one card of a split. */
export interface SplitCardInput {
  entityKind: ProposalEntityKind;
  target: string;
  properties: Record<string, unknown>;
}

export interface SplitInboxSourceInput {
  /** The source's primary card; the first entry of `cards` revises it. */
  proposalId: string;
  /** The Inbox item the thread is about; only a card whose source is this item is split. */
  subjectItemId: string;
  /** The thread and the assistant message of the turn that makes the split, recorded in every card's history. */
  threadId: string;
  messageId: string;
  /** At least 2 and at most `MAX_SPLIT_CARDS` entries: the primary card's revision first, then one sibling each. */
  cards: SplitCardInput[];
  /** The note for the history entries; each card has a default text when it is absent. */
  message?: string;
  /** The primary card's `updatedAt` as the assistant read it; a changed card is refused, as in a thread revision. */
  ifVersion?: string;
  /** The user the thread belongs to; addresses the realtime invalidation of the writes. */
  actingUserId?: string;
}

export interface SplitInboxSourceResult {
  /** The primary card, revised from the first entry. */
  primary: ItemRow;
  /** The new sibling cards, in the order of the entries after the first. */
  siblings: ItemRow[];
}

/**
 * Splits the source Inbox item of a card into `input.cards.length` proposal cards, in the caller's transaction and
 * under the primary card's row lock (`lockLiveProposal`, `FOR UPDATE`), so at most one split of a card is in flight.
 * The locks come in this order, decided in
 * `docs/adr/2026-11-14-a-source-split-locks-the-card-then-the-source-then-the-source-edge.md`: the card, the source
 * (`lockInboxSource`, `FOR UPDATE`, waiting, as confirm takes it after the card) and only then the card's `sourceInbox`
 * edge `FOR SHARE`, so the split never waits for the source while it holds the edge, which a removal of the
 * association (it holds the source and then needs the edge) would turn into a deadlock. Every sibling edge write finds
 * the source already held. The caller that proves the card from the edge first (the tool) takes the source before
 * that proof for the same reason.
 *
 * The first entry revises the primary card as a thread revision (`reviseProposalFromThreadWithClient`: the rules of
 * the revision flow, the history entry of author `ai` and kind `threadRevision`, the stale-card guard). Every other
 * entry becomes a sibling card: kind `inbox`, status `proposed`, the envelope as `proposal` and as `aiProposal`,
 * `aiVersion` 1, the same history entry shape, a `sourceInbox` edge to the same source and `splitFromProposalId` set to
 * the primary card's id. The tick recomputes only the primary card and never a sibling (`findExistingProposal`).
 * Nothing is written to a target database.
 *
 * Refused, with the NotFoundError of a missing card when the card's source is not `subjectItemId` (or that is not a
 * live Inbox item); with a
 * ValidationError when there are fewer than 2 or more than `MAX_SPLIT_CARDS` entries, when the card is itself a
 * sibling, when the card is `confirmed` or `rejected` or its source was deleted, and when an envelope is invalid;
 * with the ConflictError of a changed card when `ifVersion` is stale. Every envelope of a sibling is validated, as
 * confirm validates a card's envelope (`assertValidEnvelopeForCard`), before the first write, and the primary card's
 * revision validates its own before it writes, so a refusal writes nothing. A failure after the first write, such as
 * a database error while linking a sibling, leaves the earlier writes to the caller's transaction, which must roll
 * back: the action is meant to run in one transaction.
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
    // A source that is not there answers as a card of another item does: the same NotFoundError as a missing card.
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
        allowedSystemKeys: ["kind", "proposal", "aiProposal", "aiVersion", "history", "status", "splitFromProposalId"],
        ...(input.actingUserId === undefined ? {} : { actingUserId: input.actingUserId }),
      },
    );
    await linkSourceInboxRelation(client, config, sibling.id, input.subjectItemId);
    publishInboxCardChange(client, sibling.id, "created");
    siblings.push(sibling);
  }
  return { primary, siblings };
}
