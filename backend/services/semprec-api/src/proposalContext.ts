import type { Pool, PoolClient } from "pg";
import {
  buildTargetCatalog,
  getCalendarClock,
  listPropertiesByDatabase,
  listWritableProposalTargets,
  readProposalRelationCatalog,
  readProposalWorkspaceContext,
  withTransaction,
  type ProposalComputationInput,
  type ProposalRelationCatalogEntry,
  type ProposalWorkspaceGroup,
  type TargetCatalog,
} from "@semprec/data";
import { createLogger } from "@semprec/shared";

const logger = createLogger("proposal-context");

/** At most this many entries per kind of the workspace context (issue gh-1987). */
export const CONTEXT_LIMIT_PER_KIND = 20;

/**
 * The budget of the serialized request context in bytes (issue gh-1987): the gateway refuses a body over 1 MiB
 * (`MAX_BODY_BYTES` in `semprec-ai-gateway`'s `completeHandler.ts`), and what is not part of the context (the system
 * message, the type line, the attachment documents) has to fit in the rest.
 */
export const REQUEST_BUDGET_BYTES = 900 * 1024;

/** The order entries are dropped in when the context is over the budget: first kind first. */
const BUDGET_DROP_ORDER: ReadonlyArray<ProposalWorkspaceGroup["moduleId"]> = [
  "events",
  "companies",
  "people",
  "areas",
  "projects",
];

export interface CatalogProperty {
  key: string;
  type: string;
  options?: string[];
}
export interface CatalogTarget {
  module: string;
  databaseId: string;
  name: string;
  properties: CatalogProperty[];
  relations: ProposalRelationCatalogEntry[];
}

/** What the model needs to resolve relative dates and times: the item's capture moment and the tenant's clock. */
export interface ProposalCaptureFacts {
  /** The item's `date` and `time`: the person's wall clock at capture. Absent when the item holds no string there. */
  captureDate?: string;
  captureTime?: string;
  /** The item's `captureChannel`, when set. */
  captureChannel?: string;
  /** The tenant's timezone (an IANA name) and the current date in it (`YYYY-MM-DD`). */
  timezone: string;
  today: string;
}

/** The object `proposalComputation.ts` serializes into the request. */
export interface ProposalContext {
  /** The item's `text`, else its `transcribedText`, else an empty string. */
  text: string;
  facts: ProposalCaptureFacts;
  catalog: CatalogProperty[] | null;
  /**
   * The option keys with labels and the known text values of the target database (issue gh-1990); `null` when the
   * proposal has no target database or the database has neither a select property nor a text value to list.
   */
  targetCatalog: TargetCatalog | null;
  targets: CatalogTarget[] | null;
  workspace: ProposalWorkspaceGroup[];
  /** The set parts of the card being recomputed (`ProposalComputationInput.previousProposal`). */
  previous?: ProposalComputationInput["previousProposal"];
}

function stringProperty(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === "string" ? value : undefined;
}

/** `text` when the item holds one that is not blank, else `transcribedText` (a voice note's transcript), else empty. */
function itemText(properties: Record<string, unknown>): string {
  const text = stringProperty(properties, "text");
  if (text !== undefined && text.trim() !== "") return text;
  return stringProperty(properties, "transcribedText") ?? "";
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Drops workspace entries until the serialized context fits `REQUEST_BUDGET_BYTES`: the kinds in
 * `BUDGET_DROP_ORDER`, and within a kind the last entry first, which is the one the reader ranked lowest (the oldest
 * update; for events the farthest date). The item text, the facts and the previous state are never cut. A context that
 * still exceeds the budget with an empty workspace is returned as it is; the gateway refuses the request only when its
 * body exceeds its own 1 MiB limit, so a context between the budget and that limit is accepted.
 */
function fitToBudget(context: ProposalContext): ProposalContext {
  const workspace = structuredClone(context.workspace);
  // The workspace is the only part that changes, so the rest is measured once, with an empty list in its place.
  const rest = byteLength({ ...context, workspace: [] }) - byteLength([]);
  const size = () => rest + byteLength(workspace);
  let dropped = 0;
  for (const moduleId of BUDGET_DROP_ORDER) {
    const group = workspace.find((candidate) => candidate.moduleId === moduleId);
    while (group && group.items.length > 0 && size() > REQUEST_BUDGET_BYTES) {
      group.items.pop();
      dropped++;
    }
  }
  if (dropped > 0) logger.info({ count: dropped }, "Dropped workspace entries to fit the request budget");
  if (size() > REQUEST_BUDGET_BYTES) logger.warn({ bytes: size() }, "The proposal request context exceeds its budget");
  return { ...context, workspace };
}

async function readPropertyCatalog(client: PoolClient, databaseId: string): Promise<CatalogProperty[]> {
  const properties = await listPropertiesByDatabase(client, databaseId);
  return properties
    .filter((p) => p.type !== "relation" && p.type !== "rollup" && p.owner !== "system")
    .map((p) => {
      const options = p.config.options;
      if ((p.type === "select" || p.type === "multi_select") && Array.isArray(options)) {
        const keys = options.flatMap((o: unknown) =>
          typeof o === "object" && o !== null && "key" in o && typeof o.key === "string" ? [o.key] : [],
        );
        return { key: p.key, type: p.type, options: keys };
      }
      return { key: p.key, type: p.type };
    });
}

/**
 * Reads, in one short transaction, what a proposal request carries beyond the model's own instructions (issue
 * gh-1987): the item's text and capture facts, the tenant's timezone and today, the bounded workspace context as the
 * project `input.projectItemId`, the property catalogs, the target database's option and known-value catalog in the
 * user's language (issue gh-1990, `buildTargetCatalog`; none for a database with no select) and, for a recompute, the previous state of the card. The
 * workspace is cut to `REQUEST_BUDGET_BYTES`. The read writes nothing and the transaction is closed on return.
 */
export function readProposalContext(pool: Pool, input: ProposalComputationInput): Promise<ProposalContext> {
  const { properties } = input.sourceItem;
  return withTransaction(pool, async (client) => {
    const clock = await getCalendarClock(client);
    const workspace = await readProposalWorkspaceContext(client, {
      projectItemId: input.projectItemId,
      captureDate: properties.date,
      limitPerKind: CONTEXT_LIMIT_PER_KIND,
    });
    const catalog =
      input.entityKind === "database" && input.targetDatabaseId
        ? await readPropertyCatalog(client, input.targetDatabaseId)
        : null;
    const builtCatalog =
      input.entityKind === "database" && input.targetDatabaseId
        ? await buildTargetCatalog(client, input.targetDatabaseId, input.locale, input.projectItemId)
        : null;
    // The Task of gh-1990 adds no block for a target database with no select, so the known text values of such a
    // database are not sent either: the block exists to ground the choice of option keys.
    const targetCatalog = builtCatalog && builtCatalog.selects.length > 0 ? builtCatalog : null;
    let targets: CatalogTarget[] | null = null;
    if (input.entityKind === "database" || input.recognition) {
      targets = [];
      for (const target of await listWritableProposalTargets(client)) {
        targets.push({
          module: target.moduleId,
          databaseId: target.databaseId,
          name: target.name,
          properties: await readPropertyCatalog(client, target.databaseId),
          relations: await readProposalRelationCatalog(client, target.databaseId),
        });
      }
    }
    const captureDate = stringProperty(properties, "date");
    const captureTime = stringProperty(properties, "time");
    const captureChannel = stringProperty(properties, "captureChannel");
    return fitToBudget({
      text: itemText(properties),
      facts: {
        ...(captureDate === undefined ? {} : { captureDate }),
        ...(captureTime === undefined ? {} : { captureTime }),
        ...(captureChannel === undefined ? {} : { captureChannel }),
        timezone: clock.zone,
        today: clock.today(),
      },
      catalog,
      targetCatalog,
      targets,
      workspace,
      ...(input.previousProposal ? { previous: input.previousProposal } : {}),
    });
  });
}
