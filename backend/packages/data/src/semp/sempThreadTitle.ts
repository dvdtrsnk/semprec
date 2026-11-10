import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createLogger, currentTenantScope, type AiGatewayClientPort } from "@semprec/shared";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { requireManagedTransaction, withTransaction } from "../db/pool.js";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";

const titleSchema = z.object({ title: z.string() });
const logger = createLogger("semp-thread-title");

export async function enqueueSempThreadTitleIfFirst(
  client: PoolClient,
  threadId: string,
  messageId: string,
): Promise<void> {
  requireManagedTransaction(client);
  const thread = await client.query<{ id: string }>(
    "SELECT id FROM semp_threads WHERE id = $1 AND kind = 'chat' AND title IS NULL AND title_source = 'auto' FOR UPDATE",
    [threadId],
  );
  if (!thread.rows[0]) return;
  const first = await client.query<{ id: string; status: string | null }>(
    "SELECT id, status FROM semp_messages WHERE thread_id = $1 AND role = 'assistant' ORDER BY created_at, id LIMIT 1",
    [threadId],
  );
  if (first.rows[0]?.id !== messageId || first.rows[0].status !== "done") return;
  await enqueueJob(
    client,
    CORE_TASK_NAMES.SEMP_THREAD_TITLE,
    { threadId },
    {
      jobKey: `sempThreadTitle:${threadId}`,
      jobKeyMode: "unsafe_dedupe",
      maxAttempts: 1,
    },
  );
}

export async function handleSempThreadTitle(pool: Pool, threadId: string, gateway: AiGatewayClientPort): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Semp thread title requires a tenant scope");
  const source = await withTransaction(pool, async (client) => {
    const result = await client.query<{ user_text: string; assistant_text: string }>(
      `SELECT u.text AS user_text, a.text AS assistant_text
         FROM semp_threads t
         JOIN LATERAL (
           SELECT id, text FROM semp_messages WHERE thread_id = t.id AND role = 'user'
           ORDER BY created_at, id LIMIT 1
         ) u ON true
         JOIN LATERAL (
           SELECT text FROM semp_messages WHERE thread_id = t.id AND role = 'assistant'
             AND reply_to_message_id = u.id AND status = 'done'
           ORDER BY created_at, id LIMIT 1
         ) a ON true
        WHERE t.id = $1 AND t.kind = 'chat' AND t.title IS NULL AND t.title_source = 'auto'
          AND u.text IS NOT NULL AND a.text IS NOT NULL`,
      [threadId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      user: Array.from(row.user_text).slice(0, 1000).join(""),
      assistant: Array.from(row.assistant_text).slice(0, 1000).join(""),
      locale: await getTenantUserLocale(client),
    };
  });
  if (!source) return;
  let content: unknown;
  try {
    const response = await gateway.complete({
      projectItemId: null,
      operation: "semp_thread_title",
      temperature: 0.2,
      system: `Give this conversation a title of at most 60 characters in the user's language (locale: ${source.locale ?? "en"}).`,
      messages: [
        { role: "user", content: source.user },
        { role: "assistant", content: source.assistant },
      ],
      responseSchema: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 60 } },
        required: ["title"],
        additionalProperties: false,
      },
    });
    content = response.content;
  } catch {
    logger.warn({ threadId }, "Semp thread title generation failed");
    return;
  }
  const parsed = titleSchema.safeParse(content);
  if (!parsed.success) return;
  const normalized = Array.from(
    parsed.data.title
      .replace(/[\r\n]+/g, " ")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim(),
  )
    .slice(0, 60)
    .join("");
  if (!normalized) return;
  await withTransaction(pool, async (client) => {
    const updated = await client.query(
      "UPDATE semp_threads SET title = $2 WHERE id = $1 AND kind = 'chat' AND title IS NULL AND title_source = 'auto'",
      [threadId, normalized],
    );
    if (updated.rowCount === 1) publishSempThreadInvalidation(client, scope.tenantId, threadId);
  });
}
