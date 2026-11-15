import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import type { ComputedProposalEntityKind } from "./proposalEnvelope.js";
import type { ProcessingMethod } from "./inboxTypesStore.js";

/** What a typed Inbox item's processing method decides about the envelope the tick proposes (`readTickSnapshot`). */
export interface TickTarget {
  entityKind: ComputedProposalEntityKind;
  /** Resolved target database id of a `database` method type. */
  targetDatabaseId?: string;
  /** The module id of that target database. */
  targetModuleId?: string;
  /** The tenant's Journal database id, resolved for a `journal` method type (issue gh-1982). */
  journalDatabaseId?: string;
}

/**
 * Maps the processing method of `type` to the envelope kind the tick computes and resolves the database that kind
 * writes to: the type's `targetDatabase` for `database`, the Journal database (owner module `journal`) for `journal`,
 * and nothing for `pageContent`, where the target page is part of the content decision. The model never chooses the
 * kind. A `database` type with no `targetDatabase` and a module with no seeded database are errors, not clarifications.
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
