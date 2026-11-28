import type { PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";

const MODULES = ["projects", "people", "companies", "events"] as const;
const ACTIVE_PROJECT_STATUSES = ["inProgress", "longTerm"];

/** The longest text the context carries for one value: a name, a status, a relationship, a registration number. */
const MAX_VALUE_LENGTH = 100;

export interface ProposalWorkspaceEntry {
  id: string;
  name: string;
}
export interface ProposalWorkspaceProject extends ProposalWorkspaceEntry {
  status: string;
}
export interface ProposalWorkspacePerson extends ProposalWorkspaceEntry {
  relationship?: string;
}
export interface ProposalWorkspaceCompany extends ProposalWorkspaceEntry {
  registrationNumber?: string;
}
export interface ProposalWorkspaceEvent extends ProposalWorkspaceEntry {
  type?: string;
  date: string;
}
/** One kind of the context. A kind whose database the project may not read is absent, not an empty group. */
export type ProposalWorkspaceGroup =
  | { moduleId: "projects"; databaseId: string; items: ProposalWorkspaceProject[] }
  | { moduleId: "people"; databaseId: string; items: ProposalWorkspacePerson[] }
  | { moduleId: "companies"; databaseId: string; items: ProposalWorkspaceCompany[] }
  | { moduleId: "events"; databaseId: string; items: ProposalWorkspaceEvent[] };

export interface ProposalRelationCatalogEntry {
  key: string;
  name: string;
  targetDatabaseId: string;
  many: boolean;
}

export async function readProposalRelationCatalog(
  client: PoolClient,
  databaseId: string,
): Promise<ProposalRelationCatalogEntry[]> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Proposal relation catalog requires tenant scope");
  const visible = await client.query<Record<string, unknown>>(
    "SELECT EXISTS (SELECT 1 FROM databases WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL) AS present",
    [databaseId, scope.tenantId],
  );
  if (!z.object({ present: z.boolean() }).parse(visible.rows[0]).present) return [];
  const properties = await listPropertiesByDatabase(client, databaseId);
  const result: ProposalRelationCatalogEntry[] = [];
  for (const property of properties) {
    if (property.type !== "relation" || property.owner === "system") continue;
    const config = z.object({ targetDatabaseId: z.uuid() }).safeParse(property.config);
    if (!config.success) continue;
    const definition = await getRelationDefinitionByPropertyId(client, property.id);
    if (!definition) continue;
    result.push({
      key: property.key,
      name: property.name ?? property.key,
      targetDatabaseId: config.data.targetDatabaseId,
      many:
        definition.cardinality === "many_to_many" ||
        (definition.cardinality === "one_to_many" && definition.propertyIdA === property.id),
    });
  }
  return result;
}

const databaseRow = z.object({ id: z.uuid(), owner_module_id: z.enum(MODULES) });
const optionalText = z.string().nullable();
const itemRow = z.object({
  id: z.uuid(),
  name: z.string(),
  status: optionalText,
  relationship: optionalText,
  registration_number: optionalText,
  type: optionalText,
  date: optionalText,
});

function workspaceDateWindow(captureDate: unknown): [string | null, string | null] {
  const parsedDate = z.iso.date().safeParse(captureDate);
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  if (parsedDate.success) {
    const date = new Date(`${parsedDate.data}T00:00:00.000Z`);
    const day = 24 * 60 * 60 * 1000;
    firstDate = new Date(date.getTime() - day).toISOString().slice(0, 10);
    lastDate = new Date(date.getTime() + 14 * day).toISOString().slice(0, 10);
  }
  return [firstDate, lastDate];
}

function eligibilitySql(module: number, statuses: number, first: number, last: number): string {
  return `($${module} <> 'projects' OR properties->>'status' = ANY($${statuses}::text[]))
    AND ($${module} <> 'events' OR ($${first}::text IS NOT NULL AND left(properties->>'date', 10) BETWEEN $${first} AND $${last}))`;
}

/** Uses the context reader's predicate on the already-read current baseline, without another target read. */
export async function isWorkspaceUpdateEligible(
  client: PoolClient,
  moduleId: string | null,
  properties: Record<string, unknown>,
  captureDate: unknown,
): Promise<boolean> {
  if (moduleId !== "projects" && moduleId !== "events") return true;
  const [firstDate, lastDate] = workspaceDateWindow(captureDate);
  const result = await client.query<Record<string, unknown>>(
    `SELECT (${eligibilitySql(2, 3, 4, 5)}) AS eligible FROM (SELECT $1::jsonb AS properties) baseline`,
    [JSON.stringify(properties), moduleId, ACTIVE_PROJECT_STATUSES, firstDate, lastDate],
  );
  return z.object({ eligible: z.boolean().nullable() }).parse(result.rows[0]).eligible === true;
}

/** `properties->'key'` as a JSON string cut at `length`; `key` is a module constant, never input. */
function textValueSql(key: string, length: number = MAX_VALUE_LENGTH): string {
  return `CASE WHEN jsonb_typeof(properties->'${key}') = 'string' THEN left(properties->>'${key}', ${length}) END`;
}

const ITEM_COLUMNS_SQL = `id, left(properties->>'name', ${MAX_VALUE_LENGTH}) AS name,
  ${textValueSql("status")} AS status,
  ${textValueSql("relationship")} AS relationship,
  ${textValueSql("ico")} AS registration_number,
  ${textValueSql("type")} AS type,
  ${textValueSql("date", 10)} AS date`;

export interface ReadProposalWorkspaceContextInput {
  /** A database this project may not read contributes nothing. */
  projectItemId: string;
  /** An invalid date leaves the Events list empty. */
  captureDate: unknown;
  /** A positive integer. */
  limitPerKind: number;
}

/**
 * Reads the bounded built-in workspace context in the active tenant transaction, as project `projectItemId`: a
 * database it may not read (`listUnreadableDatabaseIds`) contributes no group at all, not even an empty one.
 */
export async function readProposalWorkspaceContext(
  client: PoolClient,
  { projectItemId, captureDate, limitPerKind }: ReadProposalWorkspaceContextInput,
): Promise<ProposalWorkspaceGroup[]> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Proposal workspace context requires tenant scope");
  if (!Number.isInteger(limitPerKind) || limitPerKind < 1)
    throw new RangeError("The workspace context limit per kind must be a positive integer");
  const [firstDate, lastDate] = workspaceDateWindow(captureDate);
  const unreadable = await listUnreadableDatabaseIds(client, projectItemId);
  const databases = await client.query<Record<string, unknown>>(
    `SELECT id, owner_module_id FROM databases
     WHERE tenant_id = $1 AND system AND archived_at IS NULL AND owner_module_id = ANY($2::text[])
     ORDER BY owner_module_id`,
    [scope.tenantId, MODULES],
  );
  const result: ProposalWorkspaceGroup[] = [];
  for (const raw of databases.rows) {
    const database = databaseRow.parse(raw);
    if (unreadable.has(database.id)) continue;
    const rows = await client.query<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS_SQL} FROM items
       WHERE tenant_id = $1 AND database_id = $2 AND deleted_at IS NULL
         AND jsonb_typeof(properties->'name') = 'string'
         AND ${eligibilitySql(3, 4, 5, 6)}
       ORDER BY CASE WHEN $3 = 'events' THEN properties->>'date' END ASC NULLS LAST,
                CASE WHEN $3 <> 'events' THEN updated_at END DESC NULLS LAST, id ASC
       LIMIT $7`,
      [
        scope.tenantId,
        database.id,
        database.owner_module_id,
        ACTIVE_PROJECT_STATUSES,
        firstDate,
        lastDate,
        limitPerKind,
      ],
    );
    const items = rows.rows.map((rawItem) => itemRow.parse(rawItem));
    const entry = (item: z.infer<typeof itemRow>): ProposalWorkspaceEntry => ({ id: item.id, name: item.name });
    // The eligibility predicate admits only a project with an active status and an event with a date.
    const required = (value: string | null): string => {
      if (value === null)
        throw new Error("A workspace item passed the eligibility predicate without its required value");
      return value;
    };
    switch (database.owner_module_id) {
      case "projects": {
        result.push({
          moduleId: "projects",
          databaseId: database.id,
          items: items.map((item) => ({
            ...entry(item),
            status: required(item.status),
          })),
        });
        break;
      }
      case "people":
        result.push({
          moduleId: "people",
          databaseId: database.id,
          items: items.map((item) => ({
            ...entry(item),
            ...(item.relationship === null ? {} : { relationship: item.relationship }),
          })),
        });
        break;
      case "companies":
        result.push({
          moduleId: "companies",
          databaseId: database.id,
          items: items.map((item) => ({
            ...entry(item),
            ...(item.registration_number === null ? {} : { registrationNumber: item.registration_number }),
          })),
        });
        break;
      case "events":
        result.push({
          moduleId: "events",
          databaseId: database.id,
          items: items.map((item) => ({
            ...entry(item),
            ...(item.type === null ? {} : { type: item.type }),
            date: required(item.date),
          })),
        });
        break;
    }
  }
  return result;
}
