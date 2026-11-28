import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, cancelJob, enqueueJob } from "@alldots/queue";
import type { AiGatewayClientPort } from "@alldots/shared";
import { withTransaction } from "../db/pool.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow } from "../types.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { connectMcpServer, type McpClientHandle } from "./mcpConnectionFactory.js";
import { McpConnectionError } from "./mcpConnectionError.js";
import { publishMcpServersInvalidation } from "./mcpServersInvalidation.js";
import {
  deactivateMcpToolRegistrationsNotIn,
  upsertClassifiedMcpToolRegistration,
} from "./mcpToolRegistrationsStore.js";
import { classifyMcpToolFromAnnotations, type McpToolAnnotationHints } from "./mcpToolAnnotationClassification.js";
import { suggestMcpToolLabels } from "./mcpToolLabelSuggestion.js";
import { assertAcceptableMcpToolSchema } from "./mcpToolSchemaPolicy.js";
import { logger } from "./logger.js";

/**
 * "Synchronize tools": run by a human, or by the `mcpServerSync` job a human's card confirmation queued. Lists
 * the tools, validates strictly, and materializes registrations in one transaction.
 *
 * Reactive to nothing: no `tools/list_changed` handler, and no agent/MCP operation can call it. It is publicly
 * exported because it never writes the user-only `granted`/`display_label` columns; it writes
 * `risk_class`/`requires_approval` only while `classification_source` is `annotation`, through the
 * non-exported `upsertClassifiedMcpToolRegistration`.
 */

/** All three are `owner: 'system'` keys owned by this action. */
const MCP_SERVER_SYNC_ALLOWED_KEYS = ["syncStatus", "lastSynced", "syncError"] as const;

export interface SyncMcpServerToolsOptions {
  actorId?: string;
}

export interface SyncMcpServerToolsResult {
  toolCount: number;
}

interface ParsedListedTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
  /** `null` when no annotations object was advertised. */
  annotationHints: McpToolAnnotationHints | null;
}

interface RawListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

/** Stops a server whose `nextCursor` never terminates. */
const MAX_LIST_TOOLS_PAGES = 1_000;

/** Fetches every page before anything is materialized, so tools on later pages are never deactivated. */
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
 * Keeps only boolean hints. A non-object is `null`, which differs from `{}`: a present empty object still takes
 * the MCP defaults.
 */
function pickAnnotationHints(annotations: unknown): McpToolAnnotationHints | null {
  if (typeof annotations !== "object" || annotations === null || Array.isArray(annotations)) return null;
  const booleanHint = (key: keyof McpToolAnnotationHints): boolean | undefined => {
    const value: unknown = Reflect.get(annotations, key);
    return typeof value === "boolean" ? value : undefined;
  };
  const hints: McpToolAnnotationHints = {};
  const readOnlyHint = booleanHint("readOnlyHint");
  const destructiveHint = booleanHint("destructiveHint");
  const openWorldHint = booleanHint("openWorldHint");
  if (readOnlyHint !== undefined) hints.readOnlyHint = readOnlyHint;
  if (destructiveHint !== undefined) hints.destructiveHint = destructiveHint;
  if (openWorldHint !== undefined) hints.openWorldHint = openWorldHint;
  return hints;
}

/**
 * The SDK already parses the response shape; this rejects what the table's `(mcp_server_item_id, tool_name)`
 * identity cannot hold: a blank or duplicate name (`ON CONFLICT` would silently collapse it). It also applies
 * `assertAcceptableMcpToolSchema`, since the schema is later compiled against model-supplied arguments. Any failure
 * fails the whole sync before a write, with a fixed message that never echoes server-supplied text.
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
    assertAcceptableMcpToolSchema(tool.inputSchema);
    parsed.push({
      name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
      annotationHints: pickAnnotationHints(tool.annotations),
    });
  }
  return parsed;
}

/**
 * `McpConnectionError` and the validation errors above carry only fixed wording and non-secret ids, so they are
 * stored verbatim; anything else gets a generic message.
 */
function safeSyncErrorMessage(err: unknown): string {
  if (err instanceof McpConnectionError || err instanceof ValidationError) return err.message;
  return "MCP tool sync failed for an unexpected reason";
}

async function lockLiveServer(client: PoolClient, mcpServersDatabaseId: string, mcpServerItemId: string) {
  const server = await lockItemById(client, mcpServersDatabaseId, mcpServerItemId);
  return server !== null && server.deletedAt === null;
}

/**
 * On success, upserts every advertised tool (annotation-derived classification unless a person set it), deactivates
 * registrations no longer advertised (only `active` flips; audit identity survives), records `syncStatus: 'ok'` and
 * announces after commit. On failure, records `syncStatus: 'error'` with a safe message and leaves registrations
 * untouched. A gone or trashed server raises `NotFoundError` before connecting, and again before writing if it was
 * trashed meanwhile; nothing is recorded then. The connection is always closed.
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
  let toolCount: number;
  try {
    handle = await connectMcpServer(pool, item, { actorId: options.actorId, purpose: "mcp_tool_sync" });
    const tools = await listAllTools(handle.client);
    const parsedTools = validateListedTools(tools);

    await withTransaction(pool, async (client) => {
      // Connecting and listing ran outside any transaction, so the item may have been trashed meanwhile (undo of its
      // confirmation).
      if (!(await lockLiveServer(client, mcpServersDatabaseId, mcpServerItemId))) {
        throw new NotFoundError(`No MCP server item '${mcpServerItemId}'`);
      }
      for (const tool of parsedTools) {
        await upsertClassifiedMcpToolRegistration(client, {
          mcpServerItemId,
          toolName: tool.name,
          toolSchema: tool.inputSchema,
          description: tool.description,
          active: true,
          classification: classifyMcpToolFromAnnotations(tool.annotationHints),
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
      // Effective tools of every project with grants on this server changed; the failure path announces nothing.
      publishMcpServersInvalidation(client);
    });

    toolCount = parsedTools.length;
  } catch (err) {
    const syncError = safeSyncErrorMessage(err);
    try {
      await withTransaction(pool, async (client) => {
        // A server item that is gone or in the Trash has no status to record.
        if (!(await lockLiveServer(client, mcpServersDatabaseId, mcpServerItemId))) return;
        await updateItemWithClient(
          client,
          {
            databaseId: mcpServersDatabaseId,
            itemId: mcpServerItemId,
            propertiesPatch: { syncStatus: "error", lastSynced: new Date().toISOString(), syncError },
          },
          { allowedSystemKeys: MCP_SERVER_SYNC_ALLOWED_KEYS },
        );
      });
    } catch (recordingErr) {
      // A failure while recording must never replace the original `err`.
      logger.error(
        { err: recordingErr, mcpServerItemId },
        "syncMcpServerTools: failed to record syncStatus:'error' after a sync failure",
      );
    }
    try {
      await handle?.close();
    } catch (closeErr) {
      // A close failure must never replace the original `err`.
      logger.error({ err: closeErr, mcpServerItemId }, "syncMcpServerTools: failed to close the MCP client handle");
    }
    throw err;
  }

  // No error in flight, so a close failure propagates as-is.
  await handle.close();
  return { toolCount };
}

/** A second enqueue for the same server collapses onto the pending job. */
export function mcpServerSyncJobKey(mcpServerItemId: string): string {
  return `mcp-server-sync-${mcpServerItemId}`;
}

/** The confirming user is the connection's `actorId`. No credential: the sync reads the stored one at connect time. */
export interface McpServerSyncPayload {
  mcpServerItemId: string;
  actingUserId: string;
}

/**
 * On the caller's transaction, so the job exists exactly when it commits. `maxAttempts: 1`: a failure is recorded on
 * the item and the user retries through `POST /api/mcp-servers/:id/sync`.
 */
export async function enqueueMcpServerSync(client: PoolClient, payload: McpServerSyncPayload): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.MCP_SERVER_SYNC,
    { mcpServerItemId: payload.mcpServerItemId, actingUserId: payload.actingUserId },
    { jobKey: mcpServerSyncJobKey(payload.mcpServerItemId), maxAttempts: 1 },
  );
}

/**
 * On the caller's transaction. An unstarted job is deleted; a running one is detached and not retried
 * (`cancelJob`), and ends as a no-op once it finds the item trashed.
 */
export async function cancelMcpServerSync(client: PoolClient, mcpServerItemId: string): Promise<void> {
  await cancelJob(client, mcpServerSyncJobKey(mcpServerItemId));
}

/**
 * Requires an acting user, the only one who can be named as the connection's actor. Returns the queued item id or
 * null.
 */
export async function enqueueMcpServerSyncForConfirm(
  client: PoolClient,
  targetDatabase: DatabaseRow | null,
  itemId: string,
  actingUserId: string | undefined,
): Promise<string | null> {
  if (targetDatabase?.ownerModuleId !== MCP_SERVERS_MODULE_ID || actingUserId === undefined) return null;
  await enqueueMcpServerSync(client, { mcpServerItemId: itemId, actingUserId });
  return itemId;
}

/**
 * After a successful sync, asks `gateway` for labels of unlabeled tools (never fails the job; skipped without a
 * gateway). `McpConnectionError` or a tool-list `ValidationError` was already recorded on the item, so the job ends
 * normally without retry or labels. `NotFoundError` (gone or trashed) is a no-op. Anything else reaches the queue.
 */
export async function handleMcpServerSyncTask(
  pool: Pool,
  payload: McpServerSyncPayload,
  gateway?: AiGatewayClientPort,
): Promise<void> {
  try {
    await syncMcpServerTools(pool, payload.mcpServerItemId, { actorId: payload.actingUserId });
  } catch (err) {
    if (err instanceof McpConnectionError || err instanceof ValidationError || err instanceof NotFoundError) return;
    throw err;
  }
  if (gateway) await suggestMcpToolLabels(pool, gateway, payload.mcpServerItemId);
}
