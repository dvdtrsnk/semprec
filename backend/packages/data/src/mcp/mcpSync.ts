import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, cancelJob, enqueueJob } from "@semprec/queue";
import type { AiGatewayClientPort } from "@semprec/shared";
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
 * The "Synchronize tools" action (issue #125), run by a human or, once a human confirmed an MCP server card, by its
 * queued `mcpServerSync` job (issue gh-1976, `handleMcpServerSyncTask` below): opens a connection through the
 * factory from #231, calls MCP `tools/list`, strictly validates the response, and
 * transactionally materializes registrations (`mcpToolRegistrationsStore.ts`, issue #124).
 *
 * Deliberately reactive to nothing: this module registers no `notifications/tools/list_changed`
 * handler of its own (the connection factory already registers none — see
 * mcpConnectionFactory.ts) and exposes no AgentTool/MCP operation that could call
 * `syncMcpServerTools` — only an authenticated human-facing caller is meant to invoke it. It IS
 * exported from this package's public `index.ts` surface (unlike `mcpGrantsAdminStore.ts`'s
 * mutations): reconciling `mcp_tool_registrations.active`/schema is the sync-facing write
 * and doing so here doesn't touch the `granted` or `display_label` columns that issue #124 carves out as user-only.
 * It writes `risk_class`/`requires_approval` only for a registration whose `classification_source` is `annotation`,
 * through `upsertClassifiedMcpToolRegistration`, which is imported here by its relative path and is not on the
 * package's public surface; the exported `upsertMcpToolRegistration` has no way to write them
 * ([[2026-11-14-mcp-tool-classification-is-owned-by-the-annotation-sync-until-a-person-sets-it]]).
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
  /** The annotation hints the server advertised, or null when it advertised no annotations object. */
  annotationHints: McpToolAnnotationHints | null;
}

interface RawListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
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
 * Keeps the three boolean hints of a listed tool's `annotations` and drops everything else, including a hint that is
 * not a boolean. Anything that is not an object is no annotations at all (null), which is not the same as an empty
 * object: a present object with no hint of its own still takes the MCP defaults in `classifyMcpToolFromAnnotations`.
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
 * The MCP SDK's `Client.listTools()` already parses the response against its own `tools/list`
 * Zod schema (rejecting a structurally malformed response before this ever runs), but that
 * schema alone doesn't rule out a response that's well-formed yet still nonsensical for this
 * table's `(mcp_server_item_id, tool_name)` identity: a blank name, or the same name listed
 * twice in one response (which `upsertMcpToolRegistration`'s `ON CONFLICT` would otherwise
 * silently collapse into whichever entry it processes last). Both fail the whole sync before
 * anything is written, with a fixed, secret-free message — never the response's own tool
 * name/description content, which originates from the (not fully trusted) server.
 *
 * Also applies `assertAcceptableMcpToolSchema` (issue #696) to each tool's `inputSchema` before
 * anything is written: a schema over 64 KiB, carrying a remote `$ref`, or carrying a `pattern`/
 * `patternProperties` regex that isn't provably safe from catastrophic backtracking fails the
 * whole sync exactly like a duplicate name does, since `mcpInvokeTool.ts` compiles and evaluates
 * this same schema against untrusted-adjacent model-supplied arguments on every future invocation.
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

/** Locks the server item and returns whether it exists and is not in the Trash, in the caller's transaction. */
async function lockLiveServer(client: PoolClient, mcpServersDatabaseId: string, mcpServerItemId: string) {
  const server = await lockItemById(client, mcpServersDatabaseId, mcpServerItemId);
  return server !== null && server.deletedAt === null;
}

/**
 * Runs one sync pass for `mcpServerItemId`, started by a human through the sync route or by the
 * `mcpServerSync` job a human's confirmation queued: connects (#231), calls
 * `tools/list`, validates it, then in a single transaction upserts every advertised tool
 * (`requires_approval`/`risk_class` come from the tool's annotations, `classifyMcpToolFromAnnotations`; an existing
 * tool whose classification a person set keeps it — see `upsertClassifiedMcpToolRegistration`), deactivates any previously-active registration the server no
 * longer advertises (`deactivateMcpToolRegistrationsNotIn` — audit identity survives, only
 * `active` flips), and records `syncStatus: 'ok'`/`lastSynced`/`syncError: null` on the server
 * item. A connection or validation failure instead records `syncStatus: 'error'` with a safe
 * message and leaves `mcp_tool_registrations` exactly as it was — prior registrations remain
 * authoritative. A server item that is gone or in the Trash raises `NotFoundError` before the connection is made, and again
 * when the registrations would be written if it went to the Trash while the tools were being listed; nothing is written
 * for it then, and no status is recorded on it. A successful pass announces one `mcpServers` invalidation once its transaction has
 * committed (`publishMcpServersInvalidation`); a failed one announces nothing. The connection is always
 * closed, on both the success and failure path.
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
      // The connection was made and the tools were listed outside any transaction: the server item can have gone to
      // the Trash meanwhile (the undo of its confirmation, gh-1984). Nothing is written for it then.
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
      // The registrations changed, and with them the effective tools of every project that has grants on the
      // server: one announcement for the tenant, in this transaction. The failure path below writes none.
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
      // The original sync failure (`err`, thrown below) is what the caller needs to see — a
      // secondary failure while merely trying to *record* it must never replace or hide it.
      logger.error(
        { err: recordingErr, mcpServerItemId },
        "syncMcpServerTools: failed to record syncStatus:'error' after a sync failure",
      );
    }
    try {
      await handle?.close();
    } catch (closeErr) {
      // Same discipline as the recordingErr handling above: `err` is what the caller needs to
      // see, so a secondary failure while merely closing the connection must never replace it.
      logger.error({ err: closeErr, mcpServerItemId }, "syncMcpServerTools: failed to close the MCP client handle");
    }
    throw err;
  }

  // No error is in flight here — a close failure is the only failure and must propagate as-is,
  // exactly as it did before this connection was ever wrapped in error-recording logic.
  await handle.close();
  return { toolCount };
}

/** The stable job key of the sync of one MCP server item: a second enqueue for the same server collapses onto the pending job. */
export function mcpServerSyncJobKey(mcpServerItemId: string): string {
  return `mcp-server-sync-${mcpServerItemId}`;
}

/**
 * The payload of an `mcpServerSync` job: the server item and the user whose confirmation created it, who is the
 * `actorId` of the sync's connection. It carries no credential: the sync reads the stored one at connect time.
 */
export interface McpServerSyncPayload {
  mcpServerItemId: string;
  actingUserId: string;
}

/**
 * Enqueues the `mcpServerSync` job of one MCP server item on the caller's open transaction, so the job exists exactly
 * when that transaction commits and a rollback leaves none. `maxAttempts: 1`: a failed sync is recorded on the item
 * (`syncStatus: error`) and the user retries it through `POST /api/mcp-servers/:id/sync`, so the queue does not.
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
 * The inverse of `enqueueMcpServerSync` (issue gh-1984), on the caller's open transaction: removes the pending sync job of
 * the server item, so the removal commits or rolls back with that transaction. A job no worker has started is deleted; one
 * a worker is running is detached from its key and not retried (`cancelJob`), and its run ends as a no-op once it finds
 * the server item in the Trash (`syncMcpServerTools`). A server item that has no job removes nothing.
 */
export async function cancelMcpServerSync(client: PoolClient, mcpServerItemId: string): Promise<void> {
  await cancelJob(client, mcpServerSyncJobKey(mcpServerItemId));
}

/**
 * The enqueue of a confirm: queues the sync of `itemId` when `targetDatabase` is the MCP servers database and the confirm
 * has an acting user (the job's payload requires one, as nobody else could be named as the actor of the connection), and
 * returns the id of the queued item, or null when nothing was queued.
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
 * The handler of the `mcpServerSync` job: runs `syncMcpServerTools` for the server as `actingUserId`, and after a sync
 * that succeeded asks `gateway` for labels of the tools that have none (`suggestMcpToolLabels`, issue gh-1983), which
 * never fails the job; without a `gateway` that step is skipped. A sync that
 * failed with an `McpConnectionError` or a tool-list `ValidationError` has tried to record `syncStatus: error` and a
 * safe `syncError` on the item (a failure of that write is logged by the sync), so the job ends normally and is not
 * retried, and no label is suggested. A `NotFoundError`, which the sync raises for a server item that does not exist or
 * is in the Trash, is a no-op. Any other error is unexpected and reaches the queue.
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
