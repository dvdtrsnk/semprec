import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  ValidationError,
  AGENT_RUN_STEP_DEFAULT_LIMIT,
  AGENT_RUN_STEP_MAX_LIMIT,
  agentRunErrorFields,
  buildAgentRunStepPage,
  getAgentRun,
  getAgentRunDetail,
  getAgentRunReplyOutcome,
  getAgentRunUsage,
  isAgentRunHistoryTruncated,
  isAgentRunReplyHistoryTruncated,
  isAgentRunStepReadSettled,
  listAgentRunEventsForStepPage,
  mintMcpRunCredential,
  projectAgentRunStepPage,
  resolveAgentRunReply,
  toManifestLocale,
  type AgentRunReplyScope,
  type AgentRunRow,
} from "@semprec/data";
import type { Pool, PoolClient } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

const MAX_BODY_BYTES = 64 * 1024;

const AGENT_RUN_PATH = /^\/api\/agent-runs\/([^/]+)$/;
const AGENT_RUN_STEPS_PATH = /^\/api\/agent-runs\/([^/]+)\/steps$/;
const MCP_CREDENTIALS_PATH = "/api/agent-runs/mcp-credentials";

interface MintMcpCredentialRequestBody {
  projectItemId?: unknown;
  capabilities?: unknown;
  task?: unknown;
}

function parseMintMcpCredentialBody(body: unknown): { projectItemId: string; capabilities: string[]; task?: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const parsed = body as MintMcpCredentialRequestBody;
  if (typeof parsed.projectItemId !== "string") {
    throw new ValidationError("'projectItemId' must be a string");
  }
  const projectItemId = assertUuid(parsed.projectItemId, "projectItemId");
  if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((c): c is string => typeof c === "string")) {
    throw new ValidationError("'capabilities' must be an array of strings");
  }
  if (parsed.task !== undefined && typeof parsed.task !== "string") {
    throw new ValidationError("'task' must be a string when present");
  }
  return { projectItemId, capabilities: parsed.capabilities, task: parsed.task };
}

/** The largest `agent_run_events.id`, a Postgres `bigint`. */
const MAX_EVENT_ID = 9_223_372_036_854_775_807n;

/**
 * The one value of a query parameter that is a string of digits; `null` when the request does not send it.
 * A repeated, empty or non-numeric parameter is a validation error naming it.
 */
function readDigitsParam(url: URL, name: string): bigint | null {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return null;
  const value = values[0]!;
  if (values.length > 1 || !/^[0-9]{1,19}$/.test(value)) {
    throw new ValidationError(`'${name}' must be a number`, { field: name });
  }
  return BigInt(value);
}

/**
 * The `messageId` of a reply-scoped read (issue #1889): `null` when the request does not send it. A repeated or
 * empty parameter and one that is not a UUID are validation errors naming it, so it never reaches a `uuid` column.
 */
function parseMessageIdParam(url: URL): string | null {
  const values = url.searchParams.getAll("messageId");
  if (values.length === 0) return null;
  if (values.length > 1) throw new ValidationError("'messageId' must be given once", { field: "messageId" });
  return assertUuid(values[0]!, "messageId");
}

/** The cursor and page size of `GET /api/agent-runs/:id/steps`, validated against the id column and the cap. */
function parseStepsQuery(url: URL): { after: string; limit: number } {
  const after = readDigitsParam(url, "after") ?? 0n;
  if (after > MAX_EVENT_ID) throw new ValidationError("'after' is not an event id", { field: "after" });
  const limit = readDigitsParam(url, "limit") ?? BigInt(AGENT_RUN_STEP_DEFAULT_LIMIT);
  if (limit < 1n || limit > BigInt(AGENT_RUN_STEP_MAX_LIMIT)) {
    throw new ValidationError(`'limit' must be between 1 and ${AGENT_RUN_STEP_MAX_LIMIT}`, { field: "limit" });
  }
  return { after: after.toString(), limit: Number(limit) };
}

/**
 * The reply a request scopes the run to: `undefined` without a `messageId` and for a run that is no chat run,
 * both of which read the whole run, and `null` when the message is not an assistant message of the run in the
 * caller's tenant, which the route answers with 404.
 */
async function resolveReply(
  client: PoolClient,
  run: AgentRunRow,
  messageId: string | null,
  locale: string,
): Promise<AgentRunReplyScope | null | undefined> {
  if (messageId === null) return undefined;
  const resolution = await resolveAgentRunReply(client, run, messageId, locale);
  if (resolution.kind === "notFound") return null;
  return resolution.kind === "wholeRun" ? undefined : resolution.reply;
}

/**
 * `GET /api/agent-runs/:id` — the destination the global approval queue's (issue #132) "source
 * agent-run link" points at — a read-only view of one run: the fields of its row (`getAgentRun`)
 * and, beside them, its title, project and heartbeat names, duration, trigger, approval counts and
 * `displayStatus` (`getAgentRunDetail`, issues #1805 and #1820), as `errorCode` and `errorSummary`
 * why it failed, the summary in the session user's locale (`agentRunErrorFields`, issue #1824; a run
 * whose reply is incomplete reads `error` with the summary of that reply, issue #1890) and,
 * as `usage`, its AI spend per model with the model names in that locale (`getAgentRunUsage`, issue
 * #1822). A run whose `actorUserId` is not the session user answers the 404 of an unknown id,
 * before anything else about the run is read. With `?messageId=<assistant message id>` (issue #1889) the
 * title, `startedAt`, `durationMs`, `approvals`, `usage` and `displayStatus` describe that one reply of a
 * chat run (`resolveAgentRunReply`); a message that is no assistant message of the run in the caller's
 * tenant answers the same 404, and a run that is not a chat run answers with the whole run.
 *
 * `GET /api/agent-runs/:id/steps?after=<eventId>&limit=<n>` (issue #1821) — the run's events grouped
 * into steps, one page at a time, with `nextCursor` to pass as the next `after` (`buildAgentRunStepPage`
 * holds the grouping and the cursor rule) and `truncatedHistory` when retention removed the run's
 * opening events. Each step carries a title, summary, target name and change in the session user's
 * locale, and an approval step the live state of its approval request (`projectAgentRunStepPage`, issues
 * #1847 and #1862). It answers 404 under the same rule as the run detail. With `?messageId=` (issue #1889)
 * only the steps of that reply's events are returned, and `truncatedHistory` says that retention removed
 * the opening events of the reply.
 *
 * `POST /api/agent-runs/mcp-credentials` (issue #220, AC34/44/47) mints a restricted, single-run
 * `agent_run` plus an opaque credential for it (`mintMcpRunCredential`) — the piece that lets an
 * MCP actor (`POST /mcp`) later prove which run it acts for, and be restricted to an explicit
 * capability subset, instead of every session sharing the fixed process-wide grant. The minted
 * token is returned exactly once, in this response; only its hash is ever persisted.
 *
 * Both routes are gated by `authenticateRequest` (issue #143), same session middleware
 * `authHandler.ts` uses — minting a credential still requires an already-authenticated human
 * session, same as every other write this handler makes.
 */
export function createAgentRunRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        if (url.pathname === MCP_CREDENTIALS_PATH) {
          if (req.method !== "POST") {
            sendJson(res, 404, { error: "Not found" });
            return;
          }

          let body: unknown;
          try {
            body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              sendJson(res, 413, { error: err.message });
              return;
            }
            throw err;
          }

          const input = parseMintMcpCredentialBody(body);
          const minted = await withTransaction(pool, (client) =>
            mintMcpRunCredential(client, { ...input, userId: identity.user.id }),
          );
          sendJson(res, 201, {
            runId: minted.run.id,
            agentProjectItemId: input.projectItemId,
            token: minted.token,
            capabilities: minted.capabilities,
            expiresAt: minted.expiresAt,
          });
          return;
        }

        const stepsMatch = url.pathname.match(AGENT_RUN_STEPS_PATH);
        if (stepsMatch && req.method === "GET") {
          // Group 1 of the route pattern is not optional, so a successful match always captured it.
          const stepsRunId = assertUuid(stepsMatch[1]!, "id");
          const query = parseStepsQuery(url);
          const messageId = parseMessageIdParam(url);
          const page = await withTransaction(pool, async (client) => {
            const run = await getAgentRun(client, stepsRunId);
            if (!run || run.actorUserId !== identity.user.id) return null;
            const reply = await resolveReply(client, run, messageId, identity.user.locale);
            if (reply === null) return null;
            // A reply that stored no event (`range` null) has no step to read; without a reply the whole run is read.
            const range = reply === undefined ? undefined : reply.range;
            const { events, hasMore } =
              range === null
                ? { events: [], hasMore: false }
                : await listAgentRunEventsForStepPage(client, run.id, query.after, query.limit, range);
            const stepPage = buildAgentRunStepPage({
              events,
              hasMore,
              after: query.after,
              limit: query.limit,
              runSettled: reply === undefined ? isAgentRunStepReadSettled(run) : reply.finished,
            });
            return {
              ...(await projectAgentRunStepPage(client, stepPage, {
                agentRunId: run.id,
                locale: identity.user.locale,
                ...(range === null || range === undefined ? {} : { range }),
              })),
              truncatedHistory:
                reply === undefined
                  ? await isAgentRunHistoryTruncated(client, run)
                  : await isAgentRunReplyHistoryTruncated(client, run.id, reply),
            };
          });
          if (!page) {
            sendJson(res, 404, { error: "Not found" });
            return;
          }
          sendJson(res, 200, page);
          return;
        }

        const match = url.pathname.match(AGENT_RUN_PATH);
        if (!match || req.method !== "GET") {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        // Group 1 of the route pattern above is not optional, so a successful match always
        // captured it; a runtime check here would be unreachable code.
        const agentRunId = assertUuid(match[1]!, "id");
        const messageId = parseMessageIdParam(url);
        const detail = await withTransaction(pool, async (client) => {
          const run = await getAgentRun(client, agentRunId);
          if (!run || run.actorUserId !== identity.user.id) return null;
          const reply = await resolveReply(client, run, messageId, identity.user.locale);
          if (reply === null) return null;
          // A run that closed as done may have an incomplete reply (issue #1890); read it once for both fields.
          // A reply-scoped read describes one reply of the run and reads no whole-run outcome.
          const replyOutcome =
            reply === undefined && run.status === "done" ? await getAgentRunReplyOutcome(client, run) : null;
          const runDetail = await getAgentRunDetail(client, run, replyOutcome, reply);
          const incompleteReply =
            runDetail.displayStatus === "error" && replyOutcome?.outcome === "incomplete" ? replyOutcome : null;
          return {
            ...run,
            ...(reply === undefined ? {} : { startedAt: reply.startedAt }),
            ...runDetail,
            ...(await agentRunErrorFields(run, identity.user.locale, incompleteReply)),
            usage: await getAgentRunUsage(client, run.id, toManifestLocale(identity.user.locale), reply?.messageId),
          };
        });
        if (!detail) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        sendJson(res, 200, detail);
      });
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * `http.createServer` discards its listener's return value, so an `async` listener turns any
   * rejection escaping the try/catch above into an unhandled rejection — which Node answers by
   * exiting the process. Keeping the boundary synchronous confines it to a 500 for the one
   * request. Same shape as `setupHandler.ts`.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
