import type { Pool } from "pg";
import { z } from "zod";
import type { AiGatewayClientPort } from "@alldots/shared";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import {
  deriveThreadTaskName,
  readThreadTaskSnapshot,
  THREAD_TASK_NAME_MAX_LENGTH,
  writeTaskOfThread,
  type ThreadTaskWriteContext,
} from "./threadTasks.js";
import type { RouteParams, RouteBody, RouteUser, RouteLocale } from "../customRoute.js";

const UNPAIRED_SURROGATE = /\p{Cs}/u;

/** Postgres refuses U+0000 in `text` and `jsonb`, and `jsonb` refuses an unpaired surrogate. */
const isStorable = (value: string): boolean => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(THREAD_TASK_NAME_MAX_LENGTH).refine(isStorable).optional(),
    date: z.iso.date().optional(),
  })
  .strict();

export interface MailThreadTaskRouteDependencies {
  /** The route has no model client of its own to fall back on. */
  aiGateway?: AiGatewayClientPort;
}

/**
 * A missing gateway is deployment misconfiguration, so it fails with a plain error (generic 500), not a
 * `ChokePointError`. Read per request so a mount without it still starts.
 */
function requireAiGateway(dependencies: MailThreadTaskRouteDependencies): AiGatewayClientPort {
  if (!dependencies.aiGateway) {
    throw new Error('custom route dependency "aiGateway" is not configured by the composition root');
  }
  return dependencies.aiGateway;
}

/**
 * `POST /api/mail/threads/:threadId/tasks` with `{ name?, date? }`. With a `name` the task is written in
 * one transaction and no model is called. Without one the model call is bracketed:
 *
 * 1. a REPEATABLE READ transaction reads the thread snapshot and its live messages' text;
 * 2. outside any transaction the gateway names the task (403 `budget_exceeded`, else 502
 *    `upstream_unavailable`);
 * 3. a transaction rechecks the snapshot and writes the task; a thread that changed meanwhile is a 409.
 */
export function createMailThreadTaskCreateRouteHandler(pool: Pool, dependencies: MailThreadTaskRouteDependencies) {
  const queueAffinity = createActionQueueAffinity();
  return async (
    ctx: RouteParams & RouteBody & RouteUser & RouteLocale,
  ): Promise<{ status: number; body: { id: string; name: string; date: string | null } }> => {
    const requested = z.uuid().safeParse(ctx.params.threadId);
    if (!requested.success) throw new ValidationError("Invalid threadId", { field: "threadId" });
    const body = bodySchema.safeParse(ctx.body);
    if (!body.success) {
      const field = body.error.issues[0]?.path[0];
      throw new ValidationError("The body must be { name?, date? }", {
        field: typeof field === "string" ? field : "body",
      });
    }
    const userId = ctx.identity.user.id;
    const context: ThreadTaskWriteContext = {
      writer: { writerKind: "user" },
      actingUserId: userId,
      humanWriterUserId: userId,
      queueAffinity,
    };
    const date = body.data.date ?? null;

    let task;
    if (body.data.name !== undefined) {
      const name = body.data.name;
      task = await withTransaction(pool, (client) =>
        writeTaskOfThread(client, requested.data, { name, date }, context),
      );
    } else {
      const snapshot = await withTransaction(pool, (client) => readThreadTaskSnapshot(client, requested.data), {
        isolation: "repeatable_read",
      });
      // After the snapshot, so an unknown thread is the same 404 whether or not a gateway is configured.
      const gateway = requireAiGateway(dependencies);
      const name = await deriveThreadTaskName(gateway, {
        conversation: snapshot.conversation,
        locale: ctx.identity.user.locale,
      });
      task = await withTransaction(pool, (client) =>
        writeTaskOfThread(client, requested.data, { name, date }, context, snapshot),
      );
    }
    const storedName = task.properties.name;
    const storedDate = task.properties.date;
    return {
      status: 201,
      body: {
        id: task.id,
        name: typeof storedName === "string" ? storedName : "",
        date: typeof storedDate === "string" ? storedDate : null,
      },
    };
  };
}
