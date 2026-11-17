// Validates `mcpServers.connectionConfig` on every item write through the choke point, inside the write's
// transaction, and confines a `stdio` config to a human writer in an admin's tenant.
import type { PoolClient } from "pg";
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { assertStorableMcpConnectionConfig } from "./mcpConnectionConfig.js";
import { publishMcpServersInvalidation } from "./mcpServersInvalidation.js";
import { tenantAllowsStdio } from "./stdioTransportPolicy.js";

async function assertWrittenConfigStorable(
  client: PoolClient,
  ownerModuleId: string | null,
  written: Record<string, unknown>,
  humanWriterUserId: string | undefined,
): Promise<void> {
  if (ownerModuleId !== MCP_SERVERS_MODULE_ID || !Object.hasOwn(written, "connectionConfig")) return;
  const config = assertStorableMcpConnectionConfig(written.connectionConfig);
  if (config.transport !== "stdio") return;
  // One message for every refusal: it must not reveal whether the writer was an agent, an /mcp client or a non-admin.
  if (humanWriterUserId === undefined || !(await tenantAllowsStdio(client, humanWriterUserId))) {
    throw new ValidationError("A stdio MCP server can only be configured by an administrator", {
      field: "connectionConfig",
    });
  }
}

export async function mcpServerItemCreateHook({
  client,
  database,
  properties,
  humanWriterUserId,
}: ItemCreateHookContext): Promise<void> {
  await assertWrittenConfigStorable(client, database.ownerModuleId, properties, humanWriterUserId);
}

/** A patch naming `active` on an MCP servers item publishes one `mcpServers` invalidation after commit. */
export async function mcpServerItemUpdateHook({
  client,
  database,
  propertiesPatch,
  humanWriterUserId,
}: ItemUpdateHookContext): Promise<void> {
  await assertWrittenConfigStorable(client, database.ownerModuleId, propertiesPatch, humanWriterUserId);
  if (database.ownerModuleId === MCP_SERVERS_MODULE_ID && Object.hasOwn(propertiesPatch, "active")) {
    publishMcpServersInvalidation(client);
  }
}
