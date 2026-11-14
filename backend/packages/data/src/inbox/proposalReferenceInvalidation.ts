import type { PoolClient } from "pg";
import type { ItemDeleteHook, ItemRestoreHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { ForbiddenError } from "../errors.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { storedEnvelopeStillValid, type InvalidReason } from "./inboxTickAction.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { appendHistoryEntry } from "./proposalHistory.js";
import { parseStoredProposalEnvelope } from "./proposalEnvelope.js";
import { envelopeReferencesOf, isCardBeingConfirmed } from "./proposalReferences.js";

/**
 * Invalidates the open Processing proposals that refer to an item that was archived or deleted, and returns them to
 * `proposed` when the item comes back (issue #1916). The hooks run in the transaction of the write that changed the
 * item, so the change of a card commits or rolls back with it. A card is found through the `referencedItemIds` its
 * writers store (`proposalReferences.ts`) and the `items_props_gin` index, never by reading every card; a card that
 * another transaction holds the lock of is skipped (docs/adr/2026-11-14-an-item-hook-invalidates-the-open-cards-of-an-item-without-waiting-for-a-card-a-confirm-holds.md).
 */

export interface ProposalReferenceConfig {
  processingProposalsDatabaseId: string;
}

/** The reasons a referenced item stops a card: the two fixable codes of `invalidReasonSchema` that name a target. */
export type TargetReasonCode = Extract<InvalidReason["code"], "targetArchived" | "targetDeleted">;

/** The longest label an `invalidReason` carries, counted in code points, as the label of a deleted source. */
const REASON_LABEL_MAX = 80;

/**
 * Locks the live cards of the Processing proposals database whose properties contain `match`, in id order, and
 * skips every card another transaction holds the lock of (`FOR UPDATE SKIP LOCKED`), so the caller never waits for a
 * confirm that locked its card first. A card the caller's own transaction is confirming (`runWhileConfirmingCard`,
 * a step of that confirm wrote the item) is skipped too, as its lock is the caller's own. `match` is a JSON
 * containment, which the `items_props_gin` index answers.
 */
async function lockCardsContaining(
  client: PoolClient,
  config: ProposalReferenceConfig,
  match: Record<string, unknown>,
): Promise<ItemRow[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties @> $2::jsonb
     ORDER BY id FOR UPDATE SKIP LOCKED`,
    [config.processingProposalsDatabaseId, JSON.stringify(match)],
  );
  const cards: ItemRow[] = [];
  for (const { id } of rows) {
    // The row lock of the card this transaction is confirming is its own, which SKIP LOCKED does not skip.
    if (isCardBeingConfirmed(client, id)) continue;
    const card = await getItemById(client, config.processingProposalsDatabaseId, id);
    if (card) cards.push(card);
  }
  return cards;
}

/** The item's title-property value as the label of an `invalidReason`, cut by code point; empty when there is none. */
async function reasonLabelOf(client: PoolClient, item: ItemRow): Promise<string> {
  const title = (await listPropertiesByDatabase(client, item.databaseId)).find((property) => property.type === "title");
  const value = title ? item.properties[title.key] : undefined;
  const characters = Array.from(typeof value === "string" ? (value.split("\n")[0] ?? "").trim() : "");
  return characters.length > REASON_LABEL_MAX
    ? `${characters.slice(0, REASON_LABEL_MAX - 1).join("")}…`
    : characters.join("");
}

/** The editor field of `card` whose value is `itemId`; empty when its stored envelope does not name the item or is of a kind this release does not know. */
function fieldOfReference(card: ItemRow, itemId: string): string {
  const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (envelope === null || "unknownKind" in envelope) return "";
  return envelopeReferencesOf(envelope).find((reference) => reference.itemId === itemId)?.field ?? "";
}

/**
 * Puts every `proposed` card that refers to `itemId` into `invalid` with the reason `reasonCode`, in the caller's
 * transaction: `status` `invalid`, `invalidReason` `{ code, field, itemId, label }` (`field` is the editor field whose
 * value is the item, `label` the item's title when the reason is written) and a history entry of kind `invalidated`.
 * Only `proposed` cards are touched: a `confirmed`, `rejected` or already `invalid` card, a card that is still
 * computing or needs clarification, and a card another transaction holds the lock of (a confirm in progress, which
 * validates its targets itself) are left as they are. Cards of another tenant are not visible to the caller's
 * connection.
 */
export async function invalidateProposalsForItem(
  client: PoolClient,
  config: ProposalReferenceConfig,
  itemId: string,
  reasonCode: TargetReasonCode,
): Promise<void> {
  const cards = await lockCardsContaining(client, config, { status: "proposed", referencedItemIds: [itemId] });
  if (cards.length === 0) return;
  const [item] = await getItemsByIdsIncludingDeleted(client, [itemId]);
  const label = item ? await reasonLabelOf(client, item) : "";
  const message =
    reasonCode === "targetArchived"
      ? "A project this proposal refers to was archived."
      : "An item this proposal refers to was deleted.";
  for (const card of cards) {
    const invalidReason: InvalidReason = { code: reasonCode, field: fieldOfReference(card, itemId), itemId, label };
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: card.id,
        propertiesPatch: {
          status: "invalid",
          invalidReason,
          history: appendHistoryEntry(card.properties.history, message, "ai", { kind: "invalidated" }),
        },
      },
      { allowedSystemKeys: ["status", "invalidReason", "history"] },
    );
    publishInboxCardChange(client, card.id, "updated");
    await enqueueJournalInboxRecomputeForProposal(client, card.id);
  }
}

/**
 * True when the card's stored envelope passes the tick's validation (`storedEnvelopeStillValid`) and the write it
 * describes is still permitted. A `ForbiddenError` of the revalidation (an archived database the envelope writes to or
 * links into, a relation property that is not writable) means the envelope is not usable now, so the card stays
 * `invalid`; it must not fail the restore of an item that has nothing to do with that database.
 */
export async function envelopeAllowsRestore(client: PoolClient, card: ItemRow): Promise<boolean> {
  try {
    return await storedEnvelopeStillValid(client, card);
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

/**
 * Returns to `proposed` the `invalid` cards whose reason is `reasonCode` for `itemId`, after the item came back, in
 * the caller's transaction: the card's stored envelope is validated again as the tick validates a computed one
 * (`storedEnvelopeStillValid`, with a refusal of a write the envelope describes counted as not valid), and a card whose
 * envelope no longer passes, because this item or another one it refers to is still unusable, stays `invalid` with
 * its reason. A restored card loses its `invalidReason` and gets a history
 * entry of kind `reopened`. A card of the same item with another reason, such as `sourceDeleted`, and a card another
 * transaction holds the lock of are left as they are.
 */
export async function restoreProposalsForItem(
  client: PoolClient,
  config: ProposalReferenceConfig,
  itemId: string,
  reasonCode: TargetReasonCode,
): Promise<void> {
  const cards = await lockCardsContaining(client, config, {
    status: "invalid",
    referencedItemIds: [itemId],
    invalidReason: { code: reasonCode, itemId },
  });
  for (const card of cards) {
    if (!(await envelopeAllowsRestore(client, card))) continue;
    await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: card.id,
        propertiesPatch: {
          status: "proposed",
          invalidReason: null,
          history: appendHistoryEntry(
            card.properties.history,
            "The item this proposal refers to is available again.",
            "ai",
            {
              kind: "reopened",
            },
          ),
        },
      },
      { allowedSystemKeys: ["status", "invalidReason", "history"] },
    );
    publishInboxCardChange(client, card.id, "updated");
    await enqueueJournalInboxRecomputeForProposal(client, card.id);
  }
}

/** The Processing proposals database of the caller's tenant, or `null` for a tenant that has none (the Inbox pipeline is not seeded). */
async function readConfig(client: PoolClient): Promise<ProposalReferenceConfig | null> {
  const database = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  return database ? { processingProposalsDatabaseId: database.id } : null;
}

/**
 * Item update hook of Projects: a write that names `status` and leaves it `archived` invalidates the open cards that
 * refer to the project (`targetArchived`), and one that leaves it anything else, `done` included, returns the cards
 * that were invalid for the project's archive and whose envelope is valid again. A `done` project is a valid target, so
 * no card is invalidated for it. Reads the stored status of the
 * written row, so a status the Projects write transform changed is the one judged.
 */
export const proposalReferenceItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== PROJECTS_MODULE_ID || !Object.hasOwn(propertiesPatch, "status")) return;
  const config = await readConfig(client);
  if (!config) return;
  if (item.properties.status === "archived")
    await invalidateProposalsForItem(client, config, item.id, "targetArchived");
  else await restoreProposalsForItem(client, config, item.id, "targetArchived");
};

/** Item delete hook, for the rows of any database: the open cards that refer to a trashed row become `invalid` (`targetDeleted`). */
export const proposalReferenceItemDeleteHook: ItemDeleteHook = async ({ client, item }) => {
  const config = await readConfig(client);
  if (config) await invalidateProposalsForItem(client, config, item.id, "targetDeleted");
};

/** Item restore hook, for the rows of any database: the cards that were invalid for a restored row return to `proposed` when their envelope is valid again. */
export const proposalReferenceItemRestoreHook: ItemRestoreHook = async ({ client, item }) => {
  const config = await readConfig(client);
  if (config) await restoreProposalsForItem(client, config, item.id, "targetDeleted");
};
