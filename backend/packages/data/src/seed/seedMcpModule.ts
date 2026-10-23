import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import type { DatabaseRow, PropertyOwner, PropertyType } from "../types.js";
import { MCP_SERVERS_MODULE_ID } from "./mcpModuleKeys.js";

// Issue #145: every shipped catalog option `s` becomes `{ key: s }` — see seedTenDatabases.ts's
// copy of this helper for the full rationale.
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
 * Seeds the `mcpServers` system database (issue #123): the "MCP connections are system
 * resources similar to mailboxes" pattern from seedEmailModule.ts, minus the secret itself —
 * a server's credential (if any) lives in `external_credentials` (issue #26), keyed by this
 * database's item id, never as a property here.
 *
 * `connectionConfig` is stored as a generic `json` property (no dedicated PropertyType exists
 * for a transport-discriminated shape) — its `stdio`/`sse`/`http` strictness is enforced in
 * application code (mcp/mcpConnectionConfig.ts), not by the schema-engine's generic
 * key/type/owner checks, the same division of labour `rollup/config.ts` and
 * `views/*ViewType.ts`'s `validateConfig` already use for a jsonb shape richer than the
 * generic property-type system understands.
 *
 * `syncStatus`/`lastSynced`/`syncError` are `owner: 'system'` — written only by the (issue
 * #125) human-triggered "Synchronize tools" action, never by a proposal/confirm write: the
 * choke point's `createItemWithClient` already refuses a caller-supplied value for a
 * system-owned key, and `assertValidProposalEnvelope` (inboxTickAction.ts) already refuses any
 * proposal envelope that names one, so this ownership by itself is what keeps sync
 * structurally unreachable from the proposal path without any MCP-specific code there.
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
      agents:
        "Purpose: host MCP (Model Context Protocol) server connections as a system resource.\n" +
        "Allowed: propose a new MCP server's name and connectionConfig via the standard database proposal/confirm path; a human supplies the credential (if any) and confirms.\n" +
        "Not allowed: writing connectionConfig fields that carry a credential (rejected outright, never stored on the item), writing syncStatus/lastSynced/syncError (owner: 'system', written only by the human-triggered Synchronize tools action), or triggering a sync itself — that action has no agent-reachable path at all.\n" +
        "General instructions: this project exists only to host MCP server items; tool discovery/grants/invocation are later issues.",
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
