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

// Invalidates open proposals referring to an item that was archived or deleted, and reopens them when it comes back.
// The hooks run in the transaction of the item write, so card changes commit or roll back with it. Cards are found via
// their stored `referencedItemIds` and `items_props_gin`, never by scanning; cards another transaction locked are
// skipped rather than waited for.

export interface ProposalReferenceConfig {
  processingProposalsDatabaseId: string;
}

export type TargetReasonCode = Extract<InvalidReason["code"], "targetArchived" | "targetDeleted">;

/** Counted in code points, like the label of a deleted source. */
const REASON_LABEL_MAX = 80;

/**
 * Locks live cards whose properties contain `match` (answered by `items_props_gin`) in id order with
 * `FOR UPDATE SKIP LOCKED`, so the caller never waits for a confirm that locked its card first. A card this
 * transaction is confirming (`runWhileConfirmingCard`) is skipped too.
 */
async function lockCardsContaining(
  client: PoolClient,
  config: ProposalReferenceConfig,
  match: Record<string, unknown>,
): Promise<ItemRow[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND properties @> $2::jsonb
     ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`,
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

async function reasonLabelOf(client: PoolClient, item: ItemRow): Promise<string> {
  const title = (await listPropertiesByDatabase(client, item.databaseId)).find((property) => property.type === "title");
  const value = title ? item.properties[title.key] : undefined;
  const characters = Array.from(typeof value === "string" ? (value.split("\n")[0] ?? "").trim() : "");
  return characters.length > REASON_LABEL_MAX
    ? `${characters.slice(0, REASON_LABEL_MAX - 1).join("")}…`
    : characters.join("");
}

/** The editor field of `card` whose value is `itemId`; empty when not named or the envelope kind is unknown. */
function fieldOfReference(card: ItemRow, itemId: string): string {
  const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (envelope === null || "unknownKind" in envelope) return "";
  return envelopeReferencesOf(envelope).find((reference) => reference.itemId === itemId)?.field ?? "";
}

/**
 * Puts every `proposed` card referring to `itemId` into `invalid` with `invalidReason` `{ code, field, itemId, label }`
 * and an `invalidated` history entry. Other statuses, and cards locked by another transaction (a confirm in progress
 * validates its targets itself), are left alone.
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
 * True when the stored envelope passes the tick's validation and its write is still permitted. A `ForbiddenError`
 * (archived database, non-writable relation) means not usable now; it must not fail the restore of an unrelated item.
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
 * Returns to `proposed` the `invalid` cards whose reason is `reasonCode` for `itemId`, when their stored envelope
 * passes revalidation (`envelopeAllowsRestore`); others stay `invalid` with their reason. Cards with another reason
 * (such as `sourceDeleted`) and cards locked by another transaction are left alone.
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

/** `null` for a tenant whose Inbox pipeline is not seeded. */
async function readConfig(client: PoolClient): Promise<ProposalReferenceConfig | null> {
  const database = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  return database ? { processingProposalsDatabaseId: database.id } : null;
}

/**
 * Projects update hook: a write leaving `status` `archived` invalidates referring cards (`targetArchived`); any other
 * status (`done` is a valid target) restores cards invalid for the archive. Judges the stored status, so a status the
 * Projects write transform changed is the one used.
 */
export const proposalReferenceItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (database.ownerModuleId !== PROJECTS_MODULE_ID || !Object.hasOwn(propertiesPatch, "status")) return;
  const config = await readConfig(client);
  if (!config) return;
  if (item.properties.status === "archived")
    await invalidateProposalsForItem(client, config, item.id, "targetArchived");
  else await restoreProposalsForItem(client, config, item.id, "targetArchived");
};

/** Item delete hook, any database: open cards referring to the trashed row become `invalid` (`targetDeleted`). */
export const proposalReferenceItemDeleteHook: ItemDeleteHook = async ({ client, item }) => {
  const config = await readConfig(client);
  if (config) await invalidateProposalsForItem(client, config, item.id, "targetDeleted");
};

/** Item restore hook, any database: cards invalid for the restored row return to `proposed` if their envelope is valid. */
export const proposalReferenceItemRestoreHook: ItemRestoreHook = async ({ client, item }) => {
  const config = await readConfig(client);
  if (config) await restoreProposalsForItem(client, config, item.id, "targetDeleted");
};
