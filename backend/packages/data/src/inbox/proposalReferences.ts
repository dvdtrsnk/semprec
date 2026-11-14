import type { PoolClient } from "pg";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { effectiveStepRelations, selectActiveSteps } from "./proposalStepGraph.js";

/**
 * The existing items a proposal envelope refers to (issue #1916), stored on the card as `referencedItemIds` so that
 * the hooks of `proposalReferenceInvalidation.ts` can find the open cards of an item that was archived or deleted.
 */

/** One item an envelope refers to, with the editor field whose value it is. */
export interface EnvelopeReference {
  itemId: string;
  field: string;
}

/**
 * The editor field of a relation list or item of a step: `key` for the primary step and for a single-step envelope,
 * `<ref>.<key>` for any other step, so it names the same control the card's editor shows.
 */
function fieldOf(stepRef: string | null, key: string): string {
  return stepRef === null ? key : `${stepRef}.${key}`;
}

/**
 * Every existing item the effective `envelope` refers to, each with its editor field, in the order they appear:
 * the targets of the relation lists of a `database` envelope; the item `target` of a `pageContent` envelope (the page
 * the entry would be appended to) and of a `relation` envelope (the item the card's source would be linked to), both
 * under the field `target`; and, for a multi-step envelope, the item a step updates or links (`itemId`) and the item
 * ids its relation lists write (`effectiveStepRelations`), for the steps the proposal carries out
 * (`selectActiveSteps`). A `{ ref }` target is another step, not an item, and a `relation` target that is a synthetic
 * occurrence id is no item yet, so neither is listed. Ids are listed in lower case, as Postgres prints them. An item
 * named in two places is listed once per place.
 * `null` (a card with no envelope) refers to nothing. A multi-step envelope whose steps are inconsistent throws the
 * `ValidationError` of `selectActiveSteps`, the one the envelope validation raises before any writer stores it.
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

/**
 * The `referencedItemIds` a writer stores with `envelope` as the card's `proposal`: the ids of
 * `envelopeReferencesOf`, each once, in the order they first appear.
 */
export function referencedItemIdsOf(envelope: ProposalEnvelope | null): string[] {
  return [...new Set(envelopeReferencesOf(envelope).map((reference) => reference.itemId))];
}

/** The cards each connection is confirming right now, so a hook that runs inside the confirm can recognise them. */
const cardsBeingConfirmed = new WeakMap<PoolClient, Set<string>>();

/**
 * Runs `run` as the confirm of the card `cardId` on `client`'s transaction. While it runs, `isCardBeingConfirmed`
 * is true for the card on that connection. The card's row lock is the confirm's own, which `FOR UPDATE SKIP LOCKED`
 * does not skip, so the reference hooks of `proposalReferenceInvalidation.ts` would otherwise find the card when a
 * step of the confirm archives or deletes an item the card refers to, and invalidate the card that is being confirmed.
 * The mark is removed when `run` settles, whatever the outcome.
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

/** True while `runWhileConfirmingCard` runs for `cardId` on `client`. */
export function isCardBeingConfirmed(client: PoolClient, cardId: string): boolean {
  return cardsBeingConfirmed.get(client)?.has(cardId) ?? false;
}
