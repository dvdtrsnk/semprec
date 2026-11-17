import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { MCP_SERVERS_MODULE_ID } from "./mcpModuleKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

// Every catalog option `s` becomes `{ key: s }`; see the copy in seedTenDatabases.ts.
function selectConfig(options: string[]): Record<string, unknown> {
  return { options: options.map((key) => ({ key })) };
}

interface PropSpec {
  key: string;
  name: string;
  type: PropertyType;
  owner?: PropertyOwner;
  config?: Record<string, unknown>;
}

async function createProps(client: PoolClient, databaseId: string, specs: PropSpec[]): Promise<void> {
  for (const spec of specs) {
    await propertiesStore.createProperty(client, {
      databaseId,
      key: spec.key,
      name: spec.name,
      type: spec.type,
      owner: spec.owner,
      config: spec.config,
    });
  }
}

export interface McpModuleResult {
  mcpServers: DatabaseRow;
}

/**
 * Seeds the `mcpServers` system database. A server's credential lives in `external_credentials` keyed by
 * the item id, never as a property here.
 *
 * `connectionConfig` is a generic `json` property; its transport-specific shape is validated in
 * mcp/mcpConnectionConfig.ts, not by the schema engine.
 *
 * `syncStatus`/`lastSynced`/`syncError` are system-owned and written only by the "Synchronize tools"
 * action: the choke point refuses caller values for system keys and `assertValidProposalEnvelope`
 * refuses envelopes naming them, so sync is unreachable from proposals without MCP-specific code.
 */
export async function seedMcpModuleInTransaction(
  client: PoolClient,
  projectsDatabaseId: string,
): Promise<McpModuleResult> {
  const mcpProject = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "MCP",
      systemActive: true,
      agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[MCP_SERVERS_MODULE_ID],
    },
  });

  const mcpServers = await databasesStore.createDatabase(client, {
    name: "MCP servers",
    system: true,
    ownerModuleId: MCP_SERVERS_MODULE_ID,
    ownerProjectItemId: mcpProject.id,
  });
  await createProps(client, mcpServers.id, [
    { key: "name", name: "Name", type: "title", owner: "user" },
    { key: "connectionConfig", name: "Connection config", type: "json", owner: "user" },
    { key: "active", name: "Active", type: "checkbox", owner: "user" },
    {
      key: "syncStatus",
      name: "Sync status",
      type: "select",
      owner: "system",
      config: selectConfig(["ok", "error", "never"]),
    },
    { key: "lastSynced", name: "Last synced", type: "date", owner: "system", config: { includeTime: true } },
    { key: "syncError", name: "Sync error", type: "text", owner: "system" },
  ]);

  await client.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [mcpServers.id]);

  return { mcpServers };
}
