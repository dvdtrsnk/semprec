import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  NotRetryableError,
  RetryPendingError,
  ValidationError,
  AGENT_RUN_STEP_DEFAULT_LIMIT,
  AGENT_RUN_STEP_MAX_LIMIT,
  agentRunErrorFields,
  buildAgentRunStepPage,
  enqueueManualHeartbeatFire,
  getAgentRun,
  getAgentRunDetail,
  getAgentRunReplyOutcome,
  getAgentRunUsage,
  getHeartbeatOccurrenceStatus,
  getRetrySuccessorId,
  isAgentRunHistoryTruncated,
  isAgentRunReplyHistoryTruncated,
  isAgentRunStepReadSettled,
  listAgentRunEventsForStepPage,
  lockHeartbeatForManualFire,
  mintMcpRunCredential,
  projectAgentRunStepPage,
  resolveAgentRunReply,
  retryHeartbeatFireJobKey,
  toManifestLocale,
  type AgentRunReplyScope,
  type AgentRunRow,
} from "@semprec/data";
import type { Pool, PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

const MAX_BODY_BYTES = 64 * 1024;

const AGENT_RUN_PATH = /^\/api\/agent-runs\/([^/]+)$/;
const AGENT_RUN_STEPS_PATH = /^\/api\/agent-runs\/([^/]+)\/steps$/;
const AGENT_RUN_RETRY_PATH = /^\/api\/agent-runs\/([^/]+)\/retry$/;
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

/** `null` when absent; a repeated, empty or non-numeric value is a validation error naming it. */
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
 * `null` when absent; a repeated, empty or non-UUID value is a validation error naming it, so it
 * never reaches a `uuid` column.
 */
function parseMessageIdParam(url: URL): string | null {
  const values = url.searchParams.getAll("messageId");
  if (values.length === 0) return null;
  if (values.length > 1) throw new ValidationError("'messageId' must be given once", { field: "messageId" });
  return assertUuid(values[0]!, "messageId");
}

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
 * `undefined` without a `messageId` and for a run that is no chat run (both read the whole run);
 * `null` when the message is not an assistant message of the run in the caller's tenant, which
 * answers 404.
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

const NOT_RETRYABLE_MESSAGE = "this run cannot be retried";
const RETRY_PENDING_MESSAGE = "an automatic attempt of this run may still run; try again later";

/**
 * Refusals, in order:
 *
 * 1. `NotRetryableError` unless the run was triggered by the heartbeat its row names, belongs to a
 * scheduled occurrence and displays `error` (which includes a finished run whose reply left a
 * failed tool call).
 * 2. `NotRetryableError` when the run already has a successor: only the last run of a chain can be
 * retried.
 * 3. By occurrence status: `queued`/`running` is `RetryPendingError` (an automatic attempt may
 * still run), `cancelled` is `NotRetryableError`, `failed` and `succeeded` go on.
 * 4. The refusals of `enqueueManualHeartbeatFire` (heartbeat disabled or event-triggered).
 *
 * The heartbeat row is locked first, so two requests for the heartbeat wait for each other. The
 * worker creates the successor in its own transaction: the job key collapses repeated requests into
 * one job, and the worker's chained insert keeps a run retried meanwhile from starting another
 * agent. The job runs once (`maxAttempts` 1). No run row is written here, because a `running` row
 * ahead of the worker would be closed by startup repair.
 */
async function queueRetryOfHeartbeatRun(client: PoolClient, run: AgentRunRow): Promise<{ jobKey: string }> {
  if (run.triggeredBy !== "heartbeat" || run.heartbeatOccurrenceId === null || run.heartbeatId === null) {
    throw new NotRetryableError(NOT_RETRYABLE_MESSAGE);
  }
  // `enqueueManualHeartbeatFire` reads the row again and refuses a heartbeat that is gone.
  await lockHeartbeatForManualFire(client, run.heartbeatId, null);
  const replyOutcome = run.status === "done" ? await getAgentRunReplyOutcome(client, run) : null;
  if ((await getAgentRunDetail(client, run, replyOutcome)).displayStatus !== "error") {
    throw new NotRetryableError(NOT_RETRYABLE_MESSAGE);
  }
  if ((await getRetrySuccessorId(client, run.id)) !== null) {
    throw new NotRetryableError(NOT_RETRYABLE_MESSAGE);
  }
  const occurrenceStatus = await getHeartbeatOccurrenceStatus(client, run.heartbeatOccurrenceId);
  if (occurrenceStatus === "queued" || occurrenceStatus === "running") {
    throw new RetryPendingError(RETRY_PENDING_MESSAGE);
  }
  if (occurrenceStatus === "cancelled") {
    throw new NotRetryableError(NOT_RETRYABLE_MESSAGE);
  }
  const queued = await enqueueManualHeartbeatFire(client, {
    heartbeatId: run.heartbeatId,
    projectItemId: null,
    trigger: { retryOfRunId: run.id },
    refuseWhileActive: false,
    jobKey: retryHeartbeatFireJobKey(run.id),
    maxAttempts: 1,
  });
  return { jobKey: queued.jobKey };
}

/**
 * `GET /api/agent-runs/:id`: one run with its derived detail, error fields and usage in the session
 * user's locale. A run whose `actorUserId` is not the session user answers the 404 of an unknown id
 * before anything else is read. With `?messageId=` the detail describes that one reply of a chat
 * run; a message that is no assistant message of the run answers the same 404, and a non-chat run
 * answers with the whole run.
 *
 * `POST /api/agent-runs/:id/retry` answers `202 {jobKey}` once the retry job is queued
 * (`queueRetryOfHeartbeatRun` holds the rules). The body is not read.
 *
 * `GET /api/agent-runs/:id/steps?after=&limit=`: the run's events grouped into steps, paged by
 * `nextCursor`, with `truncatedHistory` when retention removed the opening events. Same 404 rule
 * and `?messageId=` scoping as the detail.
 *
 * `POST /api/agent-runs/mcp-credentials` mints a single-run `agent_run` plus an opaque credential
 * restricted to a capability subset (core ids and, with `moduleRegistry`, active module capability
 * ids). The token is returned exactly once; only its hash is persisted.
 *
 * Every route requires an authenticated human session.
 */
export function createAgentRunRequestListener(pool: Pool, moduleRegistry?: ModuleRegistry) {
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
          // Resolved per request, so a module activated since startup is accepted.
          const moduleCapabilityIds = moduleRegistry === undefined ? [] : await moduleRegistry.getCapabilities();
          const minted = await withTransaction(pool, (client) =>
            mintMcpRunCredential(client, { ...input, moduleCapabilityIds, userId: identity.user.id }),
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

        const retryMatch = url.pathname.match(AGENT_RUN_RETRY_PATH);
        if (retryMatch && req.method === "POST") {
          // Group 1 of the route pattern is not optional.
          const retryRunId = assertUuid(retryMatch[1]!, "id");
          const queued = await withTransaction(pool, async (client) => {
            const run = await getAgentRun(client, retryRunId);
            if (!run || run.actorUserId !== identity.user.id) return null;
            return queueRetryOfHeartbeatRun(client, run);
          });
          if (!queued) {
            sendJson(res, 404, { error: "Not found" });
            return;
          }
          sendJson(res, 202, queued);
          return;
        }

        const stepsMatch = url.pathname.match(AGENT_RUN_STEPS_PATH);
        if (stepsMatch && req.method === "GET") {
          // Group 1 of the route pattern is not optional.
          const stepsRunId = assertUuid(stepsMatch[1]!, "id");
          const query = parseStepsQuery(url);
          const messageId = parseMessageIdParam(url);
          const page = await withTransaction(pool, async (client) => {
            const run = await getAgentRun(client, stepsRunId);
            if (!run || run.actorUserId !== identity.user.id) return null;
            const reply = await resolveReply(client, run, messageId, identity.user.locale);
            if (reply === null) return null;
            // A reply that stored no event (`range` null) has no step to read; without a reply the
            // whole run is read.
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

        // Group 1 of the route pattern is not optional.
        const agentRunId = assertUuid(match[1]!, "id");
        const messageId = parseMessageIdParam(url);
        const detail = await withTransaction(pool, async (client) => {
          const run = await getAgentRun(client, agentRunId);
          if (!run || run.actorUserId !== identity.user.id) return null;
          const reply = await resolveReply(client, run, messageId, identity.user.locale);
          if (reply === null) return null;
          // A run that closed as done may have an incomplete reply; read it once for both fields. A
          // reply-scoped read reads no whole-run outcome.
          const replyOutcome =
            reply === undefined && run.status === "done" ? await getAgentRunReplyOutcome(client, run) : null;
          const runDetail = await getAgentRunDetail(client, run, replyOutcome, reply);
          const incompleteReply =
            runDetail.displayStatus === "error" && replyOutcome?.outcome === "incomplete" ? replyOutcome : null;
          return {
            ...run,
            retriedByRunId: await getRetrySuccessorId(client, run.id),
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
   * `http.createServer` discards the listener's return value, so an async rejection would become an
   * unhandled rejection and exit the process. A synchronous boundary confines it to a 500 for the
   * one request.
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
