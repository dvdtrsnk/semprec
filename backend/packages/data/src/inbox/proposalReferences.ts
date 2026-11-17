import type { PoolClient } from "pg";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { effectiveStepRelations, selectActiveSteps } from "./proposalStepGraph.js";

// The existing items an envelope refers to, stored on the card as `referencedItemIds` so the hooks of
// `proposalReferenceInvalidation.ts` can find an item's open cards.

export interface EnvelopeReference {
  itemId: string;
  field: string;
}

/** `key` for the primary or single step, `<ref>.<key>` otherwise, matching the control the card's editor shows. */
function fieldOf(stepRef: string | null, key: string): string {
  return stepRef === null ? key : `${stepRef}.${key}`;
}

/**
 * Every existing item the effective `envelope` refers to, with its editor field, in order: `database` relation
 * targets; the `target` of a `pageContent` or `relation` envelope; and for active steps of a multi-step envelope their
 * `itemId` and relation ids. `{ ref }` targets and synthetic occurrence ids are not items. Ids are lower-case, as
 * Postgres prints them; an item named twice is listed twice. Inconsistent steps throw `selectActiveSteps`' error.
 */
export function envelopeReferencesOf(envelope: ProposalEnvelope | null): EnvelopeReference[] {
  if (envelope === null) return [];
  const references: EnvelopeReference[] = [];
  const add = (itemId: string, field: string) => {
    if (UUID_RE.test(itemId)) references.push({ itemId: itemId.toLowerCase(), field });
  };
  if (envelope.entityKind === "pageContent" || envelope.entityKind === "relation") add(envelope.target, "target");
  for (const [key, ids] of Object.entries(envelope.relations ?? {})) for (const id of ids) add(id, key);
  if (envelope.operations !== undefined) {
    for (const step of selectActiveSteps(envelope.operations)) {
      const stepRef = step.role === "primary" ? null : step.ref;
      if (step.itemId !== undefined) add(step.itemId, fieldOf(stepRef, "itemId"));
      for (const [key, targets] of Object.entries(effectiveStepRelations(step))) {
        for (const target of targets) if (typeof target === "string") add(target, fieldOf(stepRef, key));
      }
    }
  }
  return references;
}

/** The distinct ids of `envelopeReferencesOf`, in first-appearance order. */
export function referencedItemIdsOf(envelope: ProposalEnvelope | null): string[] {
  return [...new Set(envelopeReferencesOf(envelope).map((reference) => reference.itemId))];
}

/** The cards each connection is confirming right now, so a hook that runs inside the confirm can recognise them. */
const cardsBeingConfirmed = new WeakMap<PoolClient, Set<string>>();

/**
 * Runs `run` as the confirm of `cardId` on `client`. The confirm's own row lock is not skipped by
 * `FOR UPDATE SKIP LOCKED`, so without this mark the reference hooks would invalidate the card being confirmed when a
 * step archives or deletes an item it refers to. The mark is removed when `run` settles.
 */
export async function runWhileConfirmingCard<T>(client: PoolClient, cardId: string, run: () => Promise<T>): Promise<T> {
  const cards = cardsBeingConfirmed.get(client) ?? new Set<string>();
  cardsBeingConfirmed.set(client, cards);
  const added = !cards.has(cardId);
  cards.add(cardId);
  try {
    return await run();
  } finally {
    if (added) cards.delete(cardId);
    if (cards.size === 0) cardsBeingConfirmed.delete(client);
  }
}

export function isCardBeingConfirmed(client: PoolClient, cardId: string): boolean {
  return cardsBeingConfirmed.get(client)?.has(cardId) ?? false;
}
