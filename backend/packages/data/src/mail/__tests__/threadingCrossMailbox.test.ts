import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { resolveThreadId } from "../threading.js";

let pool: Pool;

async function ingest(mailboxItemId: string, messageId: string, refs: string[] = []): Promise<string> {
  const threadId = await withTransaction(pool, (client) =>
    resolveThreadId(client, { messageId, inReplyTo: refs.at(-1) ?? null, references: refs }),
  );
  await pool.query(
    `INSERT INTO mail_message_meta (item_id, mailbox_item_id, message_id, in_reply_to, "references", thread_id, envelope)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}')`,
    [mailboxItemId, messageId, refs.at(-1) ?? null, refs, threadId],
  );
  return threadId;
}

describe("cross-mailbox threading of one message", () => {
  const mailboxA = "00000000-0000-4000-8000-00000000000a";
  const mailboxB = "00000000-0000-4000-8000-00000000000b";

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("joins the thread of the same message in another mailbox", async () => {
    const a = await ingest(mailboxA, "<news@x>");
    const b = await ingest(mailboxB, "<news@x>");
    expect(b).toBe(a);
    const { rows } = await pool.query(`SELECT DISTINCT thread_id FROM mail_message_meta WHERE message_id = '<news@x>'`);
    expect(rows).toHaveLength(1);
  });

  it("ends in the ancestor's thread when the other mailbox's copy is in one", async () => {
    await ingest(mailboxA, "<root@x>");
    const a = await ingest(mailboxA, "<child@x>", ["<root@x>"]);
    const b = await ingest(mailboxB, "<child@x>");
    expect(b).toBe(a);
  });

  it("merges bridged threads and deletes the emptied mail_threads row", async () => {
    const t1 = await ingest(mailboxA, "<dup@x>");
    const t2 = await ingest(mailboxB, "<other@x>");
    expect(t2).not.toBe(t1);
    const merged = await ingest(mailboxB, "<dup@x>", ["<other@x>"]);
    expect(merged).toBe(t1 < t2 ? t1 : t2);
    const { rows } = await pool.query(`SELECT id FROM mail_threads WHERE id = ANY($1::uuid[])`, [[t1, t2]]);
    expect(rows).toHaveLength(1);
    const { rows: metas } = await pool.query(`SELECT DISTINCT thread_id FROM mail_message_meta`);
    expect(metas).toHaveLength(1);
  });

  it("keeps messages with different ids in separate threads", async () => {
    const a = await ingest(mailboxA, "<one@x>");
    const b = await ingest(mailboxB, "<two@x>");
    expect(b).not.toBe(a);
  });
});
