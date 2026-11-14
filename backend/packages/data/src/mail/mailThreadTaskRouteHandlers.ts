// Owns the HTTP route that creates a task from a mail thread (issue gh-1900). The handler parses and bounds the
// request, brackets the AI name with a snapshot read and a staleness-checked write, and answers the new task.
// Constrained by: docs/adr/2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions.md,
// docs/adr/2026-10-29-custom-route-composition-root-dependencies.md
import type { Pool } from "pg";
import { z } from "zod";
import type { AiGatewayClientPort } from "@semprec/shared";
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

/** An unpaired surrogate (Cs), which `jsonb` refuses. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/** Postgres refuses U+0000 in `text` and `jsonb`, and `jsonb` refuses an unpaired surrogate. */
const isStorable = (value: string): boolean => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(THREAD_TASK_NAME_MAX_LENGTH).refine(isStorable).optional(),
    date: z.iso.date().optional(),
  })
  .strict();

/**
 * The member of the composition root's custom-route container this route reads
 * (docs/adr/2026-10-29-custom-route-composition-root-dependencies.md). `semprec-api`'s `CustomRouteDependencies` is
 * assignable to it.
 */
export interface MailThreadTaskRouteDependencies {
  /** The gateway client that names a task without a `name` (`services/semprec-api/src/serve.ts` sets it). The route has no model client of its own to fall back on. */
  aiGateway?: AiGatewayClientPort;
}

interface MailThreadTaskRouteContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string; locale: string } };
}

/**
 * The gateway the composition root configured. A root that configured none fails the request with a plain error and not a
 * `ChokePointError`, as docs/adr/2026-10-29-custom-route-composition-root-dependencies.md decides: the deployment is
 * missing configuration, so the adapter logs the error and answers a generic 500. Read per request, never while the
 * factory runs, so a mount without it still starts.
 */
function requireAiGateway(dependencies: MailThreadTaskRouteDependencies): AiGatewayClientPort {
  if (!dependencies.aiGateway) {
    throw new Error('custom route dependency "aiGateway" is not configured by the composition root');
  }
  return dependencies.aiGateway;
}

/**
 * `POST /api/mail/threads/:threadId/tasks` with the body `{ name?, date? }` (issue gh-1900): creates a task from the
 * mail thread and answers 201 with `{ id, name, date }` of the new task (`date` is `null` without one). `name` is a
 * non-empty string of at most 500 characters and `date` a calendar date (`YYYY-MM-DD`); any other key or value is a
 * 400 naming the field it failed on (`threadId`, `name`, `date`, or `body` for a key that is none of them). An unknown thread id and another tenant's id are the same 404. The writer is the
 * session's user, derived here and never read from the request.
 *
 * With a `name` the task is written in one transaction (`writeTaskOfThread`) and no model is called. Without one
 * ([[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]):
 *
 * 1. a REPEATABLE READ transaction reads the thread's snapshot, the ids of its live messages and their text;
 * 2. outside any transaction the gateway names the task from that text with the tenant's budget
 *    (`deriveThreadTaskName`). An exhausted budget is a 403 `budget_exceeded` and any other gateway failure a 502
 *    `upstream_unavailable`, and no task is created;
 * 3. a transaction writes the task, after it has seen again that the thread and its live messages are the ones of step 1.
 *    A thread that gained, lost or was merged into another one meanwhile is a 409 `conflict` and writes nothing.
 */
export function createMailThreadTaskCreateRouteHandler(pool: Pool, dependencies: MailThreadTaskRouteDependencies) {
  const queueAffinity = createActionQueueAffinity();
  return async (
    ctx: MailThreadTaskRouteContext,
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
    // A REST session is always a person; the writer is derived here, never read from the request.
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
      // Read per request and never while the factory runs: a mount without a gateway must still start. After the
      // snapshot, so that an unknown thread is the same 404 whether or not a gateway is configured.
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
