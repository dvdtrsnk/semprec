// Validates `mcpServers.connectionConfig` on every item write that reaches the choke point (REST,
// /mcp, AgentTools, the proposal confirm path), inside the write's own transaction, and confines
// a `stdio` config to a human writer in an admin's tenant.
// Registered through ../domainWriteHooks.ts — see docs/adr/2026-10-09-item-create-domain-hooks.md.
// Constrained by: docs/adr/2026-10-16-stdio-mcp-confined-to-admin-tenants.md
import type { PoolClient } from "pg";
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { assertStorableMcpConnectionConfig } from "./mcpConnectionConfig.js";
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

export async function mcpServerItemUpdateHook({
  client,
  database,
  propertiesPatch,
  humanWriterUserId,
}: ItemUpdateHookContext): Promise<void> {
  await assertWrittenConfigStorable(client, database.ownerModuleId, propertiesPatch, humanWriterUserId);
}
