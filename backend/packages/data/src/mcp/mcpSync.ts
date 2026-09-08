import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { updateItemWithClient } from "../chokePoint/chokePoint.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { connectMcpServer, type McpClientHandle } from "./mcpConnectionFactory.js";
import { McpConnectionError } from "./mcpConnectionError.js";
import { deactivateMcpToolRegistrationsNotIn, upsertMcpToolRegistration } from "./mcpToolRegistrationsStore.js";

/**
 * The human-only "Synchronize tools" action (issue #125): opens a connection through the
 * factory from #231, calls MCP `tools/list`, strictly validates the response, and
 * transactionally materializes registrations (`mcpToolRegistrationsStore.ts`, issue #124).
 *
 * Deliberately reactive to nothing: this module registers no `notifications/tools/list_changed`
 * handler of its own (the connection factory already registers none — see
 * mcpConnectionFactory.ts) and exposes no AgentTool/MCP operation that could call
 * `syncMcpServerTools` — only an authenticated human-facing caller is meant to invoke it. It IS
 * exported from this package's public `index.ts` surface (unlike `mcpGrantsAdminStore.ts`'s
 * mutations): reconciling `mcp_tool_registrations.active`/schema is the sync-facing write
 * `upsertMcpToolRegistration` already documents itself as being safe for any consumer to reach,
 * and doing so here doesn't touch the `risk_class`/`requires_approval`/`granted` columns that
 * issue #124 carves out as user-only.
 */

/** The only keys this action is allowed to write on an `mcpServers` item — all three are `owner: 'system'`, and this sync action is their declared owning process (seedMcpModule.ts). */
const MCP_SERVER_SYNC_ALLOWED_KEYS = ["syncStatus", "lastSynced", "syncError"] as const;

export interface SyncMcpServerToolsOptions {
  /** Forwarded to `connectMcpServer`'s `credential_access_log.actor_id`. */
  actorId?: string;
}

export interface SyncMcpServerToolsResult {
  /** How many tools the server advertised (and were upserted as active) this pass. */
  toolCount: number;
}

interface ParsedListedTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

interface RawListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Guards against a misbehaving server whose `nextCursor` never terminates — comfortably above any real tool catalog. */
const MAX_LIST_TOOLS_PAGES = 1_000;

/**
 * `tools/list` may paginate (`nextCursor` in the response) — fetches every page before
 * validating/materializing anything, so a paginated first page alone never causes
 * `deactivateMcpToolRegistrationsNotIn` to deactivate tools that only appear on a later page.
 */
export async function listAllTools(client: McpClientHandle["client"]): Promise<RawListedTool[]> {
  const tools: RawListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_TOOLS_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    if (!result.nextCursor) return tools;
    cursor = result.nextCursor;
  }
  throw new ValidationError("MCP server's tools/list response never terminated pagination");
}

/**
 * The MCP SDK's `Client.listTools()` already parses the response against its own `tools/list`
 * Zod schema (rejecting a structurally malformed response before this ever runs), but that
 * schema alone doesn't rule out a response that's well-formed yet still nonsensical for this
 * table's `(mcp_server_item_id, tool_name)` identity: a blank name, or the same name listed
 * twice in one response (which `upsertMcpToolRegistration`'s `ON CONFLICT` would otherwise
 * silently collapse into whichever entry it processes last). Both fail the whole sync before
 * anything is written, with a fixed, secret-free message — never the response's own tool
 * name/description content, which originates from the (not fully trusted) server.
 */
function validateListedTools(tools: readonly RawListedTool[]): ParsedListedTool[] {
  const seenNames = new Set<string>();
  const parsed: ParsedListedTool[] = [];
  for (const tool of tools) {
    const name = tool.name.trim();
    if (name.length === 0) {
      throw new ValidationError("MCP server's tools/list response included a tool with an empty name");
    }
    if (seenNames.has(name)) {
      throw new ValidationError("MCP server's tools/list response listed the same tool name more than once");
    }
    seenNames.add(name);
    parsed.push({ name, description: tool.description ?? null, inputSchema: tool.inputSchema });
  }
  return parsed;
}

/**
 * Maps whatever `syncMcpServerTools` caught to the text persisted in `syncError`: `McpConnectionError`
 * (#231) and the strict-validation `ValidationError` above are both already built from fixed
 * wording plus non-secret identifiers only, so their `message` is safe to store verbatim. Anything
 * else (a bug, a transient failure this function didn't anticipate) gets a fixed generic message
 * instead of that error's own possibly-unsafe `message`.
 */
function safeSyncErrorMessage(err: unknown): string {
  if (err instanceof McpConnectionError || err instanceof ValidationError) return err.message;
  return "MCP tool sync failed for an unexpected reason";
}

/**
 * Runs one explicit, human-triggered sync pass for `mcpServerItemId`: connects (#231), calls
 * `tools/list`, validates it, then in a single transaction upserts every advertised tool
 * (new names get the default `requires_approval`/`risk_class` from `mcp_tool_registrations`'
 * own column defaults; an existing tool's human-set classification is left untouched — see
 * `upsertMcpToolRegistration`), deactivates any previously-active registration the server no
 * longer advertises (`deactivateMcpToolRegistrationsNotIn` — audit identity survives, only
 * `active` flips), and records `syncStatus: 'ok'`/`lastSynced`/`syncError: null` on the server
 * item. A connection or validation failure instead records `syncStatus: 'error'` with a safe
 * message and leaves `mcp_tool_registrations` exactly as it was — prior registrations remain
 * authoritative. The connection is always closed, on both the success and failure path.
 */
export async function syncMcpServerTools(
  pool: Pool,
  mcpServerItemId: string,
  options: SyncMcpServerToolsOptions = {},
): Promise<SyncMcpServerToolsResult> {
  const { mcpServersDatabaseId, item } = await withTransaction(pool, async (client) => {
    const database = await databasesStore.getDatabaseByModuleId(client, MCP_SERVERS_MODULE_ID);
    if (!database) throw new Error("mcpServers database not seeded — was seedMcpModuleInTransaction run?");
    const mcpServerItem = await getItemById(client, database.id, mcpServerItemId);
    if (!mcpServerItem || mcpServerItem.deletedAt) {
      throw new NotFoundError(`No MCP server item '${mcpServerItemId}'`);
    }
    return { mcpServersDatabaseId: database.id, item: mcpServerItem };
  });

  let handle: McpClientHandle | undefined;
  try {
    handle = await connectMcpServer(pool, item, { actorId: options.actorId, purpose: "mcp_tool_sync" });
    const tools = await listAllTools(handle.client);
    const parsedTools = validateListedTools(tools);

    await withTransaction(pool, async (client) => {
      for (const tool of parsedTools) {
        await upsertMcpToolRegistration(client, {
          mcpServerItemId,
          toolName: tool.name,
          toolSchema: tool.inputSchema,
          description: tool.description,
          active: true,
        });
      }
      await deactivateMcpToolRegistrationsNotIn(
        client,
        mcpServerItemId,
        parsedTools.map((tool) => tool.name),
      );
      await updateItemWithClient(
        client,
        {
          databaseId: mcpServersDatabaseId,
          itemId: mcpServerItemId,
          propertiesPatch: { syncStatus: "ok", lastSynced: new Date().toISOString(), syncError: null },
        },
        { allowedSystemKeys: MCP_SERVER_SYNC_ALLOWED_KEYS },
      );
    });

    return { toolCount: parsedTools.length };
  } catch (err) {
    const syncError = safeSyncErrorMessage(err);
    try {
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: mcpServersDatabaseId,
            itemId: mcpServerItemId,
            propertiesPatch: { syncStatus: "error", lastSynced: new Date().toISOString(), syncError },
          },
          { allowedSystemKeys: MCP_SERVER_SYNC_ALLOWED_KEYS },
        ),
      );
    } catch (recordingErr) {
      // The original sync failure (`err`, thrown below) is what the caller needs to see — a
      // secondary failure while merely trying to *record* it must never replace or hide it.
      console.error("syncMcpServerTools: failed to record syncStatus:'error' after a sync failure", recordingErr);
    }
    throw err;
  } finally {
    await handle?.close();
  }
}
