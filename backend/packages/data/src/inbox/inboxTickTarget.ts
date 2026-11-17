import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import type { ComputedProposalEntityKind } from "./proposalEnvelope.js";
import type { ProcessingMethod } from "./inboxTypesStore.js";

export interface TickTarget {
  entityKind: ComputedProposalEntityKind;
  targetDatabaseId?: string;
  targetModuleId?: string;
  journalDatabaseId?: string;
}

/**
 * `pageContent` resolves no database: the target page is part of the content decision. The model never chooses the
 * kind. A `database` type without `targetDatabase` and a module without a seeded database are errors, not
 * clarifications.
 */
export async function resolveTickTarget(
  client: PoolClient,
  type: ItemRow,
  processingMethod: ProcessingMethod,
): Promise<TickTarget> {
  if (processingMethod === "journal") {
    const journal = await databasesStore.getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
    if (!journal) throw new Error(`No database seeded for owner_module_id '${JOURNAL_MODULE_ID}'`);
    return { entityKind: "journalEntry", journalDatabaseId: journal.id };
  }
  if (processingMethod !== "database") return { entityKind: "pageContent" };
  const typeTarget = type.properties.targetDatabase;
  if (typeof typeTarget !== "string") {
    throw new Error(`Inbox item type ${type.id} has processingMethod 'database' but no 'targetDatabase'`);
  }
  const targetDatabase = await databasesStore.getDatabaseByModuleId(client, typeTarget);
  if (!targetDatabase) throw new Error(`No database seeded for owner_module_id '${typeTarget}'`);
  return { entityKind: "database", targetDatabaseId: targetDatabase.id, targetModuleId: typeTarget };
}
