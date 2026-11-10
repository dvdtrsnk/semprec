import type { Pool, PoolClient } from "pg";
import {
  listPropertiesByDatabase,
  listWritableProposalTargets,
  readProposalRelationCatalog,
  readProposalWorkspaceContext,
  withTransaction,
  type ProposalComputationInput,
  type ProposalRelationCatalogEntry,
  type ProposalWorkspaceGroup,
} from "@semprec/data";

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
export interface ProposalContext {
  catalog: CatalogProperty[] | null;
  targets: CatalogTarget[] | null;
  workspace: ProposalWorkspaceGroup[];
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

export function readProposalContext(pool: Pool, input: ProposalComputationInput): Promise<ProposalContext> {
  return withTransaction(pool, async (client) => {
    const workspace = await readProposalWorkspaceContext(client, input.sourceItem.properties.date);
    const catalog =
      input.entityKind === "database" && input.targetDatabaseId
        ? await readPropertyCatalog(client, input.targetDatabaseId)
        : null;
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
    return { catalog, targets, workspace };
  });
}
