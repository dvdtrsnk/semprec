// Issue gh-1933: what the agent receives for a `mailThread` ref. The turn is built by `expandSempRefs`, the function
// the agent run calls; a merged-away thread id reaches the agent as the id of the current thread, which the agent
// reads with `mail.thread.get` (issue gh-1927).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import {
  createItemWithClient,
  LocalFsBlobStorageWriter,
  resolveMailModuleIds,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
} from "@semprec/data/testSupport";
import { expandSempRefs } from "../refExpansion.js";

describe("expansion of a mailThread ref for the agent", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;
  let foreign: string;
  let root: string;
  let storage: LocalFsBlobStorageWriter;

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    root = await mkdtemp(join(tmpdir(), "semp-ref-thread-expansion-"));
    storage = new LocalFsBlobStorageWriter(root);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const close of [
      () => runtime?.end(),
      () => admin?.end(),
      () => (root ? rm(root, { recursive: true }) : undefined),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Reference fixture cleanup failed", { cause: errors[0] });
  });

  /**
   * A mailbox of `tenantId` with a folder of `specialPurpose` and an `ingest(name, references)` of messages into it; the
   * answer names the thread each message joined.
   */
  async function mailbox(tenantId: string, specialPurpose: string) {
    return runInTenant(tenantId, () =>
      withTransaction(runtime, async (client: PoolClient) => {
        const ids = await resolveMailModuleIds(client);
        const property = async (databaseId: string, key: string) => {
          const { rows } = await client.query<{ id: string }>(
            "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
            [databaseId, key],
          );
          if (!rows[0]) throw new Error(`Missing ${key} property`);
          return rows[0].id;
        };
        const mailboxItem = await createItemWithClient(client, {
          databaseId: ids.mailboxesDatabaseId,
          properties: { name: "Mail", provider: "generic" },
        });
        const folderItemId = await ensureFolderItem(client, {
          foldersDatabaseId: ids.foldersDatabaseId,
          mailboxItemId: mailboxItem.id,
          mailboxRelationPropertyId: await property(ids.foldersDatabaseId, "mailbox"),
          providerId: specialPurpose,
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
        const folderProperty = await property(ids.emailsDatabaseId, "folder");
        const attachmentsProperty = await property(ids.emailsDatabaseId, "attachments");
        return {
          ids,
          mailboxItemId: mailboxItem.id,
          folderItemId,
          folderProperty,
          attachmentsProperty,
        };
      }),
    );
  }

  /** One message of `tenantId` through the ingest writer, answering the thread it joined. */
  async function ingest(
    tenantId: string,
    box: Awaited<ReturnType<typeof mailbox>>,
    input: { name: string; subject: string; date?: string; references?: string[] },
  ): Promise<string> {
    return runInTenant(tenantId, () =>
      withTransaction(runtime, async (client) => {
        const references = (input.references ?? []).map((name) => `<${name}@example.test>`);
        const { itemId } = await ingestEmailMessage(client, {
          emailsDatabaseId: box.ids.emailsDatabaseId,
          filesDatabaseId: box.ids.filesDatabaseId,
          folderRelationPropertyId: box.folderProperty,
          attachmentsRelationPropertyId: box.attachmentsProperty,
          folderItemId: box.folderItemId,
          mailboxItemId: box.mailboxItemId,
          messageId: `<${input.name}@example.test>`,
          inReplyTo: references.at(-1) ?? null,
          references,
          subject: input.subject,
          date: new Date(input.date ?? "2026-11-01T10:00:00Z"),
          envelope: {},
          attachments: [],
          storage,
          storageKeyPrefix: "thread-ref-expansion",
        });
        const { rows } = await client.query<{ thread_id: string | null }>(
          "SELECT thread_id FROM mail_message_meta WHERE item_id = $1",
          [itemId],
        );
        const threadId = rows[0]?.thread_id;
        if (!threadId) throw new Error(`Message ${input.name} has no thread`);
        return threadId;
      }),
    );
  }

  const expand = (tenantId: string, refs: unknown[]) => runInTenant(tenantId, () => expandSempRefs(runtime, refs));

  it("hands the agent the current thread id for a merged-away ref, and labels the ref with the subject", async () => {
    const box = await mailbox(tenant, "inbox");
    const name = randomUUID();
    const survivor = await ingest(tenant, box, { name: `${name}-root`, subject: "Budget" });
    const merged = await ingest(tenant, box, {
      name: `${name}-reply`,
      subject: "Re: Budget talk",
      date: "2026-11-03T10:00:00Z",
      references: [`${name}-bridge`],
    });
    expect(merged).not.toBe(survivor);
    expect(await ingest(tenant, box, { name: `${name}-bridge`, subject: "Budget", references: [`${name}-root`] })).toBe(
      survivor,
    );

    const expanded = await expand(tenant, [{ kind: "mailThread", threadId: merged }]);

    expect(expanded.text).toContain(`mailThread: Re: Budget talk\n{"threadId":"${survivor}"}`);
    expect(expanded.text).not.toContain(merged);
    expect(expanded.context).toEqual([{ kind: "mailThread", threadId: merged, label: "Re: Budget talk" }]);
    expect(expanded.images).toEqual([]);
  });

  it("marks a thread whose messages are all in Trash and says a purged or foreign thread is unavailable", async () => {
    const box = await mailbox(tenant, "trash");
    const foreignBox = await mailbox(foreign, "inbox");
    const trashed = await ingest(tenant, box, { name: randomUUID(), subject: "Binned" });
    const foreignThread = await ingest(foreign, foreignBox, { name: randomUUID(), subject: "Private subject" });
    const purged = randomUUID();

    const expanded = await expand(tenant, [
      { kind: "mailThread", threadId: trashed },
      { kind: "mailThread", threadId: purged },
      { kind: "mailThread", threadId: foreignThread },
    ]);

    expect(expanded.text).toContain(`mailThread: [trashed] Binned\n{"threadId":"${trashed}"}`);
    expect(expanded.text.match(/mailThread: no longer exists or is unavailable\./g)).toHaveLength(2);
    expect(expanded.text).not.toContain("Private subject");
    expect(expanded.text).not.toContain(foreignThread);
    expect(expanded.context.map((ref) => ref.kind === "mailThread" && ref.label)).toEqual(["Binned", "", ""]);
  });
});
