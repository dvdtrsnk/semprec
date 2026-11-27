import type { Pool, PoolClient } from "pg";
import {
  buildTargetCatalog,
  EVENTS_MODULE_ID,
  getCalendarClock,
  listPropertiesByDatabase,
  listWritableProposalTargets,
  readPastEventDurations,
  readProposalRelationCatalog,
  readProposalWorkspaceContext,
  withTransaction,
  type PastEventDuration,
  type ProposalComputationInput,
  type ProposalRelationCatalogEntry,
  type ProposalWorkspaceGroup,
  type TargetCatalog,
} from "@semprec/data";
import { createLogger } from "@semprec/shared";

const logger = createLogger("proposal-context");

export const CONTEXT_LIMIT_PER_KIND = 20;

/**
 * The gateway refuses a body over 1 MiB (`MAX_BODY_BYTES` in `semprec-ai-gateway`), and the system
 * message, type line and attachment documents must fit in the rest.
 */
export const REQUEST_BUDGET_BYTES = 900 * 1024;

/** First kind first. */
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

/** What the model needs to resolve relative dates and times. */
export interface ProposalCaptureFacts {
  /** The person's wall clock at capture. Absent when the item holds no string there. */
  captureDate?: string;
  captureTime?: string;
  captureChannel?: string;
  /** An IANA name, with the current date in it (`YYYY-MM-DD`). */
  timezone: string;
  today: string;
}

export interface ProposalContext {
  /** The item's `text`, else its `transcribedText`, else an empty string. */
  text: string;
  facts: ProposalCaptureFacts;
  catalog: CatalogProperty[] | null;
  /**
   * `null` when there is no target database or it has neither a select property nor a text value to
   * list.
   */
  targetCatalog: TargetCatalog | null;
  targets: CatalogTarget[] | null;
  workspace: ProposalWorkspaceGroup[];
  /**
   * Events target only: per person of the People group, up to five of their most recent same-day
   * Events with both times, newest first. A person with none has no key. Absent when the project
   * may not read People or Events. A person dropped from the People group to fit the budget is
   * dropped here too.
   */
  pastEventDurations?: Record<string, PastEventDuration[]>;
  previous?: ProposalComputationInput["previousProposal"];
}

function stringProperty(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === "string" ? value : undefined;
}

function itemText(properties: Record<string, unknown>): string {
  const text = stringProperty(properties, "text");
  if (text !== undefined && text.trim() !== "") return text;
  return stringProperty(properties, "transcribedText") ?? "";
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Drops kinds in `BUDGET_DROP_ORDER`, and within a kind the lowest-ranked (last) entry first; a
 * dropped person loses their past event durations too. Item text, facts and the previous state are
 * never cut. A context still over budget with an empty workspace is returned as is; the gateway
 * only refuses past its own 1 MiB limit.
 */
function fitToBudget(context: ProposalContext): ProposalContext {
  const workspace = structuredClone(context.workspace);
  const durations = context.pastEventDurations && structuredClone(context.pastEventDurations);
  // Only the workspace and durations change, so the rest is measured once.
  const rest = byteLength({ ...context, workspace: [], pastEventDurations: undefined }) - byteLength([]);
  const size = () => rest + byteLength(workspace) + (durations ? byteLength({ pastEventDurations: durations }) : 0);
  let dropped = 0;
  for (const moduleId of BUDGET_DROP_ORDER) {
    const group = workspace.find((candidate) => candidate.moduleId === moduleId);
    while (group && group.items.length > 0 && size() > REQUEST_BUDGET_BYTES) {
      const removed = group.items.pop();
      if (durations && moduleId === "people" && removed) delete durations[removed.id];
      dropped++;
    }
  }
  if (dropped > 0) logger.info({ count: dropped }, "Dropped workspace entries to fit the request budget");
  if (size() > REQUEST_BUDGET_BYTES) logger.warn({ bytes: size() }, "The proposal request context exceeds its budget");
  return { ...context, workspace, ...(durations ? { pastEventDurations: durations } : {}) };
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
 * One short read-only transaction, read as the project `input.projectItemId`: item text and capture
 * facts, the tenant's timezone and today, the bounded workspace context, the property catalogs, the
 * target database's option and known-value catalog in the user's language, and the previous card
 * state on recompute. The workspace is cut to `REQUEST_BUDGET_BYTES`.
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
    // Only an Events proposal carries the people's earlier Event lengths, and only when the project
    // may read both People and Events (the workspace has no group for a database it may not read).
    const people = workspace.find((group) => group.moduleId === "people");
    const pastEventDurations =
      input.entityKind === "database" &&
      input.targetModuleId === EVENTS_MODULE_ID &&
      people &&
      workspace.some((group) => group.moduleId === "events")
        ? await readPastEventDurations(
            client,
            people.items.map((person) => person.id),
          )
        : undefined;
    const catalog =
      input.entityKind === "database" && input.targetDatabaseId
        ? await readPropertyCatalog(client, input.targetDatabaseId)
        : null;
    const builtCatalog =
      input.entityKind === "database" && input.targetDatabaseId
        ? await buildTargetCatalog(client, input.targetDatabaseId, input.locale, input.projectItemId)
        : null;
    // The block exists to ground the choice of option keys, so a target database with no select
    // sends no block and no known text values.
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
      ...(pastEventDurations ? { pastEventDurations } : {}),
      ...(input.previousProposal ? { previous: input.previousProposal } : {}),
    });
  });
}
