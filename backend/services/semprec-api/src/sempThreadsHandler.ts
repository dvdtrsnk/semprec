import type { Pool } from "pg";
import { z } from "zod";
import { sempMessageRefSchema } from "@semprec/shared";
import {
  getSempThread,
  listSempThreadMessages,
  NotFoundError,
  sendSempMessage,
  validateSempMessageRefs,
  ValidationError,
  withTransaction,
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

export function createSempThreadRoutes(pool: Pool): RouteDefinition[] {
  return [
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
        const thread = await withTransaction(pool, (client) => getSempThread(client, id));
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
        const result = await withTransaction(pool, async (client) => {
          if (!(await getSempThread(client, id))) throw new NotFoundError("Thread not found");
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
