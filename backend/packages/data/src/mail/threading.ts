import type { PoolClient } from "pg";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { createMailThread, reassignThread } from "./mailMessageMetaStore.js";

/**
 * JWZ-style (jwz.org/doc/threading.html) threading, run incrementally per incoming message: a message whose
 * ancestor has not synced yet starts its own thread, which is merged once the ancestor arrives. Both directions are
 * checked (do my `In-Reply-To`/`References` have a thread? does an already-synced message reference me?), and another
 * copy of the same `Message-ID` in another mailbox is consulted first (lowest `thread_id` wins). Must run, and its
 * result be stored as `upsertMailMessageMeta`'s `threadId`, before this message's own `mail_message_meta` row exists,
 * so the "does anyone reference me" query never sees itself. `X-GM-THRID` is deliberately not consulted: this is the
 * provider-independent mechanism.
 */
export interface ThreadResolutionInput {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Only used if a brand-new thread must be created — debug/UI hint, never the threading key. */
  subjectHint?: string;
}

export async function resolveThreadId(client: PoolClient, input: ThreadResolutionInput): Promise<string> {
  await lockMailThreadMutation(client);
  const ancestorIds = [
    ...new Set([input.inReplyTo ?? undefined, ...(input.references ?? [])].filter((v): v is string => Boolean(v))),
  ];

  const foundThreadIds = new Set<string>();

  // Strongest evidence first: another copy of this very message (same `Message-ID`, any
  // mailbox). Lowest thread id first so the merge target is deterministic when several differ.
  const { rows: sameMessageRows } = await client.query<{ thread_id: string }>(
    `SELECT DISTINCT thread_id FROM mail_message_meta WHERE message_id = $1 AND thread_id IS NOT NULL ORDER BY thread_id`,
    [input.messageId],
  );
  for (const row of sameMessageRows) foundThreadIds.add(row.thread_id);

  if (ancestorIds.length > 0) {
    const { rows } = await client.query<{ thread_id: string | null }>(
      `SELECT thread_id FROM mail_message_meta WHERE message_id = ANY($1::text[]) AND thread_id IS NOT NULL`,
      [ancestorIds],
    );
    for (const row of rows) if (row.thread_id) foundThreadIds.add(row.thread_id);
  }

  // Self-heal: an already-synced message that names this one as its parent or ancestor.
  const { rows: descendantRows } = await client.query<{ thread_id: string | null }>(
    `SELECT thread_id FROM mail_message_meta WHERE thread_id IS NOT NULL AND (in_reply_to = $1 OR $1 = ANY("references"))`,
    [input.messageId],
  );
  for (const row of descendantRows) if (row.thread_id) foundThreadIds.add(row.thread_id);

  // No thread found: this message starts one. Several found (a message bridging two threads): merge them all into the
  // first, an arbitrary but stable choice.
  const [target, ...rest] = [...foundThreadIds];
  if (target === undefined) {
    const thread = await createMailThread(client, input.subjectHint);
    return thread.id;
  }
  for (const other of rest) {
    await reassignThread(client, other, target);
  }
  return target;
}
