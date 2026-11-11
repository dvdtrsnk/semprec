import type { Pool } from "pg";
import { z } from "zod";
import { sempMessageRefSchema } from "@semprec/shared";
import {
  getSempThread,
  listSempThreadMessages,
  listSempThreads,
  NotFoundError,
  parseSempThreadListCursor,
  SEMP_THREAD_KINDS,
  sendSempMessage,
  validateSempMessageRefs,
  ValidationError,
  withTransaction,
  type HeartbeatRuleKindRegistry,
  type SempThreadKind,
} from "@semprec/data";
import {
  assertUuid,
  requireJsonObjectBody,
  requireStringField,
  requireUuidParam,
} from "./adapter/requestValidation.js";
import type { RouteDefinition } from "./adapter/routeTable.js";

const messageRunSchema = z
  .object({
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    status: z.enum(["running", "done", "error"]),
  })
  .nullable();

/**
 * The tick-thread fields of `GET /api/semp/threads/:id` (issue #1562), checked before they are sent: the
 * stored rule is JSONB and the header joins two other tables. Only a tick thread carries the two keys.
 */
const tickThreadHeaderSchema = z.strictObject({
  heartbeat: z
    .strictObject({
      id: z.uuid(),
      name: z.string(),
      rule: z.object({ kind: z.string().min(1) }).passthrough(),
      enabled: z.boolean(),
      projectItemId: z.uuid(),
      projectName: z.string().nullable(),
      canTrigger: z.boolean(),
    })
    .nullable(),
  activeRun: z.strictObject({ agentRunId: z.uuid(), startedAt: z.iso.datetime() }).nullable(),
});

function parseMessageInput(value: unknown) {
  const body = requireJsonObjectBody(value);
  const text = requireStringField(body, "text");
  if (!text.trim()) throw new ValidationError("'text' must not be whitespace", { field: "text" });
  const submitted = body.context === undefined ? [] : body.context;
  if (!Array.isArray(submitted) || submitted.length > 20) {
    throw new ValidationError("Invalid 'context'", { field: "context" });
  }
  const context = submitted.map((value: unknown, index: number) => {
    const parsed = sempMessageRefSchema.safeParse(value);
    if (!parsed.success) throw new ValidationError("Invalid reference", { field: `context[${index}]` });
    return parsed.data;
  });
  return { text, context, hasContext: "context" in body };
}

function parseCursor(value: string | null): { createdAt: string; id: string } | null {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("Invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Invalid cursor");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("createdAt" in parsed) ||
      !("id" in parsed)
    )
      throw new Error("Invalid cursor");
    const { createdAt, id } = parsed;
    if (
      typeof createdAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(createdAt) ||
      createdAt.startsWith("0000-") ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== `${createdAt.slice(0, 23)}Z` ||
      typeof id !== "string"
    )
      throw new Error("Invalid cursor");
    return { createdAt, id: assertUuid(id, "before") };
  } catch {
    throw new ValidationError("Invalid 'before' cursor", { field: "before" });
  }
}

/** The kinds `GET /api/semp/threads` returns when the request names none: chats and Inbox item threads. */
const DEFAULT_LIST_KINDS: readonly SempThreadKind[] = ["chat", "item"];

/** The value of a query parameter that may be given at most once; null when it is absent. */
function singleQueryValue(query: URLSearchParams, name: string): string | null {
  const values = query.getAll(name);
  if (values.length > 1) throw new ValidationError(`'${name}' must be given at most once`, { field: name });
  return values[0] ?? null;
}

function parseListKinds(value: string): SempThreadKind[] {
  const kinds = new Set<SempThreadKind>();
  for (const entry of value.split(",")) {
    const kind = SEMP_THREAD_KINDS.find((known) => known === entry);
    if (kind === undefined) {
      throw new ValidationError("'kind' must be a comma-separated list of chat, item and tick", { field: "kind" });
    }
    kinds.add(kind);
  }
  return [...kinds];
}

/** Longest search text `GET /api/semp/threads` takes in `q`, in Unicode code points. */
const MAX_SEARCH_CODE_POINTS = 100;

/** The validated query of `GET /api/semp/threads` (issues #1729 and #1737). */
function parseThreadListQuery(query: URLSearchParams) {
  const rawKind = singleQueryValue(query, "kind");
  const rawSubject = singleQueryValue(query, "subjectInboxItemId");
  const rawLimit = singleQueryValue(query, "limit");
  if (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100))
    throw new ValidationError("'limit' must be an integer between 1 and 100", { field: "limit" });
  const rawCursor = singleQueryValue(query, "cursor");
  // Trimmed first: only the text that is searched counts against the cap, and a blank `q` is no filter.
  // Postgres refuses a NUL character in a text value, so one is refused here.
  const search = singleQueryValue(query, "q")?.trim() ?? "";
  if (search.includes("\u0000") || Array.from(search).length > MAX_SEARCH_CODE_POINTS)
    throw new ValidationError(`'q' must be at most ${MAX_SEARCH_CODE_POINTS} characters without a NUL character`, {
      field: "q",
    });
  return {
    kinds: rawKind === null ? DEFAULT_LIST_KINDS : parseListKinds(rawKind),
    subjectInboxItemId: rawSubject === null ? null : assertUuid(rawSubject, "subjectInboxItemId"),
    search: search === "" ? null : search,
    limit: rawLimit === null ? 50 : Number(rawLimit),
    cursor: rawCursor === null ? null : parseSempThreadListCursor(rawCursor),
  };
}

/** `heartbeatRuleKinds` resolves the active modules' rule kinds per request (`resolveModuleRuleKinds`). */
export function createSempThreadRoutes(
  pool: Pool,
  heartbeatRuleKinds: () => Promise<HeartbeatRuleKindRegistry>,
): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/semp/threads",
      handler: async (ctx) => {
        const input = parseThreadListQuery(new URL(ctx.req.url ?? "/", "http://localhost").searchParams);
        const result = await withTransaction(pool, (client) =>
          listSempThreads(client, { ...input, locale: ctx.identity.user.locale }),
        );
        return { status: 200, body: result };
      },
    },
    {
      method: "POST",
      path: "/api/semp/threads",
      handler: async (ctx) => {
        const body = requireJsonObjectBody(ctx.body);
        const message = parseMessageInput(body);
        let subject: { inboxItemId: string; proposalId?: string } | undefined;
        if (body.subject !== undefined) {
          const value = requireJsonObjectBody(body.subject);
          const inboxItemId = assertUuid(requireStringField(value, "inboxItemId"), "inboxItemId");
          const proposalId =
            value.proposalId === undefined
              ? undefined
              : assertUuid(requireStringField(value, "proposalId"), "proposalId");
          subject = { inboxItemId, ...(proposalId === undefined ? {} : { proposalId }) };
        }
        const result = await withTransaction(pool, async (client) =>
          sendSempMessage(client, {
            ...message,
            subject,
            context: await validateSempMessageRefs(client, message.context),
          }),
        );
        return { status: 202, body: result };
      },
    },
    {
      method: "POST",
      path: "/api/semp/threads/:id/messages",
      handler: async (ctx) => {
        const threadId = requireUuidParam(ctx.params, "id");
        const message = parseMessageInput(ctx.body);
        const result = await withTransaction(pool, async (client) =>
          sendSempMessage(client, {
            ...message,
            threadId,
            context: await validateSempMessageRefs(client, message.context),
          }),
        );
        return { status: 202, body: result };
      },
    },
    {
      method: "GET",
      path: "/api/semp/threads/:id",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const ruleKinds = await heartbeatRuleKinds();
        const thread = await withTransaction(pool, (client) => getSempThread(client, id, ruleKinds));
        if (!thread) throw new NotFoundError("Thread not found");
        if (thread.kind === "tick") {
          tickThreadHeaderSchema.parse({ heartbeat: thread.heartbeat, activeRun: thread.activeRun });
        } else if (Object.hasOwn(thread, "heartbeat") || Object.hasOwn(thread, "activeRun")) {
          throw new Error("Only a tick thread carries a heartbeat header");
        }
        return { status: 200, body: thread };
      },
    },
    {
      method: "GET",
      path: "/api/semp/threads/:id/messages",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const query = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
        const rawLimit = query.get("limit");
        if (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100))
          throw new ValidationError("'limit' must be an integer between 1 and 100", { field: "limit" });
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        const before = parseCursor(query.get("before"));
        const ruleKinds = await heartbeatRuleKinds();
        const result = await withTransaction(pool, async (client) => {
          if (!(await getSempThread(client, id, ruleKinds))) throw new NotFoundError("Thread not found");
          return listSempThreadMessages(client, id, limit, before);
        });
        return {
          status: 200,
          body: { ...result, rows: result.rows.map((row) => ({ ...row, run: messageRunSchema.parse(row.run) })) },
        };
      },
    },
  ];
}
