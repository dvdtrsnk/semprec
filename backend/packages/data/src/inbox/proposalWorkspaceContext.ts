import type { PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";

const MODULES = ["projects", "areas", "people", "companies", "events"] as const;
const ACTIVE_PROJECT_STATUSES = ["inProgress", "longTerm"];
type WorkspaceModule = (typeof MODULES)[number];

export interface ProposalWorkspaceEntry {
  id: string;
  name: string;
}
export interface ProposalWorkspaceGroup {
  moduleId: WorkspaceModule;
  databaseId: string;
  items: ProposalWorkspaceEntry[];
}

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
const itemRow = z.object({ id: z.uuid(), name: z.string() });

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

/** Reads only the fixed, bounded built-in workspace context under the active tenant transaction. */
export async function readProposalWorkspaceContext(
  client: PoolClient,
  captureDate: unknown,
): Promise<ProposalWorkspaceGroup[]> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Proposal workspace context requires tenant scope");
  const [firstDate, lastDate] = workspaceDateWindow(captureDate);
  const databases = await client.query<Record<string, unknown>>(
    `SELECT id, owner_module_id FROM databases
     WHERE tenant_id = $1 AND system AND archived_at IS NULL AND owner_module_id = ANY($2::text[])
     ORDER BY owner_module_id`,
    [scope.tenantId, MODULES],
  );
  const result: ProposalWorkspaceGroup[] = [];
  for (const raw of databases.rows) {
    const database = databaseRow.parse(raw);
    const rows = await client.query<Record<string, unknown>>(
      `SELECT id, left(properties->>'name', 100) AS name FROM items
       WHERE tenant_id = $1 AND database_id = $2 AND deleted_at IS NULL
         AND jsonb_typeof(properties->'name') = 'string'
         AND ${eligibilitySql(3, 4, 5, 6)}
       ORDER BY CASE WHEN $3 = 'events' THEN properties->>'date' END ASC NULLS LAST,
                CASE WHEN $3 <> 'events' THEN updated_at END DESC NULLS LAST, id ASC
       LIMIT 20`,
      [scope.tenantId, database.id, database.owner_module_id, ACTIVE_PROJECT_STATUSES, firstDate, lastDate],
    );
    result.push({
      moduleId: database.owner_module_id,
      databaseId: database.id,
      items: rows.rows.map((rawItem) => {
        const item = itemRow.parse(rawItem);
        return { id: item.id, name: item.name.slice(0, 100) };
      }),
    });
  }
  return result;
}
