import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { SEMPREC_READ_ONLY_MODULE_IDS, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import type { ProposalStep } from "./inboxTickAction.js";

/**
 * One step as the model names it: `database` is a module id from the writable target catalog (`create`); `itemId`
 * an existing item (`update`, `link`); `alias` the local name later operations use as a relation target.
 */
export interface ProposalComputationOperation {
  op: "create" | "update" | "link";
  database?: string;
  itemId?: string;
  alias?: string;
  properties?: Record<string, unknown>;
  relations?: Record<string, Array<string | { alias: string }>>;
  /**
   * Set only by the duplicate step on the `update` of an existing company or person, making it the primary step. Not
   * in the model's answer schema and not copied into the stored step.
   */
  primary?: true;
}

export const MAX_PROPOSAL_OPERATIONS = 6;

export interface WritableProposalTarget {
  moduleId: string;
  databaseId: string;
  name: string;
}

/** The non-archived system databases a proposal may write to (the Inbox's own are read-only for it). */
export async function listWritableProposalTargets(client: PoolClient): Promise<WritableProposalTarget[]> {
  const databases = await databasesStore.listAllDatabases(client);
  return databases.flatMap((database) =>
    database.system &&
    database.ownerModuleId &&
    database.ownerModuleId !== PROCESSING_PROPOSALS_MODULE_ID &&
    !SEMPREC_READ_ONLY_MODULE_IDS.includes(database.ownerModuleId)
      ? [{ moduleId: database.ownerModuleId, databaseId: database.id, name: database.name ?? database.ownerModuleId }]
      : [],
  );
}

/**
 * Builds multi-step envelope steps: refs are the aliases (or `op<n>`); the primary is the operation marked `primary`,
 * else the first `create` into the type's target, else the first operation (which validation then rejects).
 */
export function buildProposalSteps(
  operations: ProposalComputationOperation[],
  targetModuleId: string | undefined,
): ProposalStep[] {
  const refs = operations.map((operation, index) => operation.alias ?? `op${index + 1}`);
  const marked = operations.findIndex((operation) => operation.primary === true);
  const primaryIndex =
    marked >= 0
      ? marked
      : Math.max(
          0,
          operations.findIndex((operation) => operation.op === "create" && operation.database === targetModuleId),
        );
  return operations.map((operation, index) => {
    const step: ProposalStep = {
      ref: refs[index]!,
      op: operation.op,
      role: index === primaryIndex ? "primary" : "secondary",
    };
    if (operation.database !== undefined) step.databaseKey = operation.database;
    if (operation.itemId !== undefined) step.itemId = operation.itemId;
    if (operation.properties !== undefined) step.properties = operation.properties;
    if (operation.relations !== undefined) {
      step.relations = Object.fromEntries(
        Object.entries(operation.relations).map(([key, targets]) => [
          key,
          targets.map((target) => (typeof target === "string" ? target : { ref: target.alias })),
        ]),
      );
    }
    if (operation.op === "update") {
      step.after = {
        ...(step.properties ? { properties: step.properties } : {}),
        ...(step.relations ? { relations: step.relations } : {}),
      };
    }
    return step;
  });
}
