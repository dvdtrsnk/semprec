// Validates `mcpServers.connectionConfig` on every item write that reaches the choke point (REST,
// /mcp, AgentTools, the proposal confirm path), inside the write's own transaction.
// Registered through ../domainWriteHooks.ts — see docs/adr/2026-10-09-item-create-domain-hooks.md.
import type { ItemCreateHookContext, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { assertStorableMcpConnectionConfig } from "./mcpConnectionConfig.js";

function assertWrittenConfigStorable(ownerModuleId: string | null, written: Record<string, unknown>): void {
  if (ownerModuleId !== MCP_SERVERS_MODULE_ID || !Object.hasOwn(written, "connectionConfig")) return;
  assertStorableMcpConnectionConfig(written.connectionConfig);
}

export async function mcpServerItemCreateHook({ database, properties }: ItemCreateHookContext): Promise<void> {
  assertWrittenConfigStorable(database.ownerModuleId, properties);
}

export async function mcpServerItemUpdateHook({ database, propertiesPatch }: ItemUpdateHookContext): Promise<void> {
  assertWrittenConfigStorable(database.ownerModuleId, propertiesPatch);
}
