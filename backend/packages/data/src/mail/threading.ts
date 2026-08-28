import type { Queryable } from "../db/pool.js";
import { createMailThread, reassignThread } from "./mailMessageMetaStore.js";

/**
 * JWZ-style (jwz.org/doc/threading.html) conversation threading, adapted to run
 * incrementally per incoming message rather than as a batch rebuild: a `Message-ID` whose
 * ancestor hasn't synced yet gets its own thread (the "dummy container" case) instead of
 * staying unthreaded, and that thread self-heals the moment the missing ancestor arrives —
 * this function checks both directions (do any of *my* `In-Reply-To`/`References` already
 * have a thread? does any *already-synced* message reference *me*?) and merges whatever it
 * finds into one thread. Must be called and its result stored (via `upsertMailMessageMeta`'s
 * `threadId`) before this message's own `mail_message_meta` row exists, so the "does anyone
 * reference me" query below only sees genuinely prior messages, never itself.
 *
 * `X-GM-THRID` (Gmail's own heuristic threading) is deliberately not consulted here — this
 * is the universal (Gmail + iCloud + generic IMAP) mechanism; the Gmail adapter stores
 * `X-GM-THRID` as `provider_thread_id` purely as an auxiliary cross-check column.
 */
export interface ThreadResolutionInput {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Only used if a brand-new thread must be created — debug/UI hint, never the threading key. */
  subjectHint?: string;
}

export async function resolveThreadId(client: Queryable, input: ThreadResolutionInput): Promise<string> {
  const ancestorIds = [...new Set([input.inReplyTo ?? undefined, ...(input.references ?? [])].filter((v): v is string => Boolean(v)))];

  const foundThreadIds = new Set<string>();

  if (ancestorIds.length > 0) {
    const { rows } = await client.query<{ thread_id: string | null }>(
      `SELECT thread_id FROM mail_message_meta WHERE message_id = ANY($1::text[]) AND thread_id IS NOT NULL`,
      [ancestorIds],
    );
    for (const row of rows) if (row.thread_id) foundThreadIds.add(row.thread_id);
  }

  // Self-heal: an already-synced message that names *this* message as its parent/ancestor,
  // arrived before this one did.
  const { rows: descendantRows } = await client.query<{ thread_id: string | null }>(
    `SELECT thread_id FROM mail_message_meta WHERE thread_id IS NOT NULL AND (in_reply_to = $1 OR $1 = ANY("references"))`,
    [input.messageId],
  );
  for (const row of descendantRows) if (row.thread_id) foundThreadIds.add(row.thread_id);

  if (foundThreadIds.size === 0) {
    const thread = await createMailThread(client, input.subjectHint);
    return thread.id;
  }

  // More than one distinct thread found (e.g. a message that bridges two previously
  // separate dummy-container threads): merge them all into the first — an arbitrary but
  // stable choice, since which one "wins" has no product meaning beyond "one thread."
  const [target, ...rest] = [...foundThreadIds];
  for (const other of rest) {
    await reassignThread(client, other, target);
  }
  return target;
}
