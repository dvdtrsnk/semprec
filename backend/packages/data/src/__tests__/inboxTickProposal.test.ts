import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient, deleteInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { createBlob } from "../blobs/blobsStore.js";
import { deleteInboxAttachment, insertInboxAttachments, listInboxAttachments } from "../inbox/inboxAttachmentsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { ValidationError } from "../errors.js";
import {
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  type ComputeSemprecProposalFn,
  type ProposalEnvelope,
  type ProposalStep,
} from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../inbox/proposalActions.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/** The version 1 fingerprint (issue #223), pinned by formula: the tick no longer writes it (issue #1606). */
function legacyFingerprintOf(emoji: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ emoji, text })).digest("hex");
}

/**
 * The version 2 fingerprint (issue #1606) written out by hand: canonical JSON with the keys in code-point
 * order and the attachment hashes sorted, and `transcribedText` empty. The test does not reuse the
 * production function it checks.
 */
function fingerprintV2Of(input: {
  typeId: string;
  text: string;
  date?: string;
  time?: string;
  attachmentHashes?: string[];
}): string {
  const canonical = JSON.stringify({
    attachmentHashes: [...(input.attachmentHashes ?? [])].sort(),
    date: input.date ?? "2026-08-28",
    text: input.text,
    time: input.time ?? "09:00",
    transcribedText: "",
    typeId: input.typeId,
    v: 2,
  });
  return `v2:${createHash("sha256").update(canonical).digest("hex")}`;
}

type TickDatabaseIds = {
  inboxDatabaseId: string;
  inboxItemTypesDatabaseId: string;
  processingProposalsDatabaseId: string;
};

async function findProposalForItem(tickPool: Pool, proposalsId: string, itemId: string) {
  return withTransaction(tickPool, async (client) => {
    const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
    const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty!.id);
    // Every edge, not `edges[0]`: the same scan production's `findExistingProposal` does, so a
    // soft-deleted proposal still linked to the item is skipped here as it is there.
    const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
    for (const edge of edges) {
      const proposal = await itemsStore.getItemById(client, proposalsId, relationsStore.otherSide(edge, itemId));
      if (proposal && !proposal.deletedAt) return proposal;
    }
    return null;
  });
}

async function runTick(
  tickPool: Pool,
  databaseIds: TickDatabaseIds,
  itemId: string,
  computeProposal: ComputeSemprecProposalFn,
): Promise<void> {
  const handler = createSemprecTickAction(tickPool, computeProposal);
  await handler(databaseIds, { heartbeatId: "hb", projectItemId: "proj", itemId });
}

describe("semprec.tick fingerprinting and proposal create/revise/skip (issue #223)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
    databaseIds = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
  });

  it("creates exactly one proposed row with the generic envelope and correct fingerprint for a 'database' type", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );

    let calls = 0;
    await runTick(pool, databaseIds, item.id, async (input) => {
      calls++;
      expect(input.projectItemId).toBe("proj");
      expect(input.entityKind).toBe("database");
      expect(input.targetDatabaseId).toBeTruthy();
      return { properties: { name: "Buy milk" } };
    });
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("proposed");
    expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    expect(proposal!.properties.history).toHaveLength(1);
    const entry = (proposal!.properties.history as Array<Record<string, unknown>>)[0]!;
    expect(entry).toMatchObject({ author: "ai" });
    expect(typeof entry.message).toBe("string");
    expect(typeof entry.at).toBe("string");

    const tasksDbId = await databaseIdFor("tasks");
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: tasksDbId,
      properties: { name: "Buy milk" },
    });
    expect(Object.keys(proposal!.properties.proposal as object).sort()).toEqual(["entityKind", "properties", "target"]);
  });

  describe("locale passed to computeProposal", () => {
    async function createTaskInboxItem(): Promise<string> {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
      const item = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          journalDatabaseId: journalId,
          timezone: "Europe/Prague",
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
          type: type.id,
        }),
      );
      return item.id;
    }

    it("passes the bound user's locale", async () => {
      await runInTenant(getTenantZeroId(), () =>
        createUser(pool, { email: "en@example.com", passwordHash: "x", locale: "en", tenantId: getTenantZeroId() }),
      );
      const itemId = await createTaskInboxItem();

      const locales: string[] = [];
      await runInTenant(getTenantZeroId(), () =>
        runTick(pool, databaseIds, itemId, async (input) => {
          locales.push(input.locale);
          return { properties: { name: "Buy milk" } };
        }),
      );
      expect(locales).toEqual(["en"]);
    });

    it("falls back to cs when the tenant has no bound user", async () => {
      const itemId = await createTaskInboxItem();

      const locales: string[] = [];
      await runInTenant(getTenantZeroId(), () =>
        runTick(pool, databaseIds, itemId, async (input) => {
          locales.push(input.locale);
          return { properties: { name: "Buy milk" } };
        }),
      );
      expect(locales).toEqual(["cs"]);
    });
  });

  it("uses the injected function's target for a 'pageContent' type", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async (input) => {
      expect(input.entityKind).toBe("pageContent");
      expect(input.targetDatabaseId).toBeUndefined();
      return { target: type.id, properties: { flavour: "paragraph", fields: { content: "A thought" } } };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "pageContent",
      target: type.id,
      properties: { flavour: "paragraph", fields: { content: "A thought" } },
    });
  });

  it("an unchanged fingerprint makes no AI call and no proposal write", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = await findProposalForItem(pool, proposalsId, item.id);

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for an unchanged fingerprint");
    });
    const second = await findProposalForItem(pool, proposalsId, item.id);
    expect(second!.updatedAt).toBe(first!.updatedAt);
  });

  it("an edit that changes the fingerprint revises the same row rather than creating a second one", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const first = await findProposalForItem(pool, proposalsId, item.id);

    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));
    const revised = await findProposalForItem(pool, proposalsId, item.id);

    expect(revised!.id).toBe(first!.id);
    expect(revised!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(revised!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
    expect(revised!.properties.history).toHaveLength(2);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(1);
  });

  describe("version 2 fingerprint inputs and the version 1 compatibility rule (issue #1606)", () => {
    async function createInboxType(name: string, emoji: string) {
      return withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name,
          emoji,
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
    }

    async function createInboxItemOfType(text: string, typeId: string) {
      return withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          journalDatabaseId: journalId,
          timezone: "Europe/Prague",
          date: "2026-08-28",
          time: "09:00",
          text,
          type: typeId,
        }),
      );
    }

    async function editInboxItem(itemId: string, propertiesPatch: Record<string, unknown>) {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch }),
      );
    }

    /** Creates a blob whose content hash is derived from `label` and attaches it to the Inbox item. */
    async function attachNewBlob(itemId: string, label: string) {
      const contentHash = createHash("sha256").update(label).digest("hex");
      const blob = await createBlob(pool, {
        mimeType: "image/jpeg",
        byteSize: 3,
        storageKey: `t/blobs/${label}`,
        contentHash,
      });
      await insertInboxAttachments(pool, itemId, [{ blobId: blob.id, source: "camera" }]);
      return { blobId: blob.id, contentHash };
    }

    async function detachBlob(itemId: string, blobId: string) {
      const attachments = await listInboxAttachments(pool, [itemId]);
      const attachment = attachments.find((row) => row.blobId === blobId);
      if (!attachment) throw new Error(`Inbox item ${itemId} has no attachment of blob ${blobId}`);
      await deleteInboxAttachment(pool, attachment.attachmentId);
    }

    /**
     * Sets the stored fingerprint of a proposal. The tick no longer writes version 1 values, so a
     * card that holds one (as a card written before issue #1606 does) is built by setting it here.
     */
    async function setProposalFingerprint(proposalId: string, fingerprint: string) {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposalId,
          propertiesPatch: { fingerprint },
        }),
      );
    }

    it.each([
      { field: "time", patch: { time: "10:30" } },
      { field: "date", patch: { date: "2026-08-29" } },
    ])("a changed capture $field recomputes the proposal", async ({ patch }) => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(1);

      await editInboxItem(item.id, patch);
      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(2);
      const proposal = await findProposalForItem(pool, proposalsId, item.id);
      expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk", ...patch }));
    });

    it("adding an attachment to the item and then removing it each recomputes the proposal", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(1);

      const photo = await attachNewBlob(item.id, "photo");
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      const withPhoto = await findProposalForItem(pool, proposalsId, item.id);
      expect(withPhoto!.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [photo.contentHash] }),
      );

      await detachBlob(item.id, photo.blobId);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(3);
      const withoutPhoto = await findProposalForItem(pool, proposalsId, item.id);
      expect(withoutPhoto!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    });

    it("reordering the attachments of an item does not recompute the proposal", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      const first = await attachNewBlob(item.id, "first");
      const second = await attachNewBlob(item.id, "second");
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const before = await findProposalForItem(pool, proposalsId, item.id);

      // Attachments are ordered by position, so moving `first` behind `second` reverses the pair.
      await detachBlob(item.id, first.blobId);
      await insertInboxAttachments(pool, item.id, [{ blobId: first.blobId, source: "camera" }]);
      const attachments = await listInboxAttachments(pool, [item.id]);
      expect(attachments.map((row) => row.blobId)).toEqual([second.blobId, first.blobId]);

      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called when only the attachment order changed");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties.fingerprint).toBe(before!.properties.fingerprint);
      expect(after!.updatedAt).toBe(before!.updatedAt);
    });

    it("choosing another type that shares the emoji recomputes the proposal", async () => {
      const task = await createInboxType("Task", "☑️");
      const errand = await createInboxType("Errand", "☑️");
      const item = await createInboxItemOfType("Buy milk", task.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      const before = await findProposalForItem(pool, proposalsId, item.id);

      await withTransaction(pool, async (client) => {
        const typeProperty = await propertiesStore.getPropertyByKey(client, inboxId, "type");
        await deleteRelationWithClient(client, {
          relationPropertyId: typeProperty!.id,
          callerItemId: item.id,
          targetItemId: task.id,
        });
        await createRelationWithClient(client, {
          relationPropertyId: typeProperty!.id,
          callerItemId: item.id,
          targetItemId: errand.id,
        });
      });
      await runTick(pool, databaseIds, item.id, compute);

      expect(calls).toBe(2);
      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.id).toBe(before!.id);
      expect(after!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: errand.id, text: "Buy milk" }));
      expect(after!.properties.fingerprint).not.toBe(before!.properties.fingerprint);
    });

    it("a version 1 card whose emoji and text are unchanged is not recomputed, even when its time changes", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const created = await findProposalForItem(pool, proposalsId, item.id);
      await setProposalFingerprint(created!.id, legacyFingerprintOf("☑️", "Buy milk"));
      const legacyCard = await findProposalForItem(pool, proposalsId, item.id);

      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for an unchanged version 1 fingerprint");
      });

      await editInboxItem(item.id, { time: "10:30" });
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called when only the time of a version 1 card changed");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties.fingerprint).toBe(legacyFingerprintOf("☑️", "Buy milk"));
      expect(after!.updatedAt).toBe(legacyCard!.updatedAt);
    });

    it("a version 1 card whose text changed is recomputed and stored as a version 2 fingerprint", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const created = await findProposalForItem(pool, proposalsId, item.id);
      await setProposalFingerprint(created!.id, legacyFingerprintOf("☑️", "Buy milk"));

      await editInboxItem(item.id, { text: "Buy bread" });
      let calls = 0;
      await runTick(pool, databaseIds, item.id, async () => {
        calls++;
        return { properties: { name: "Buy bread" } };
      });

      expect(calls).toBe(1);
      const revised = await findProposalForItem(pool, proposalsId, item.id);
      expect(revised!.id).toBe(created!.id);
      expect(revised!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy bread" }));
    });

    it("a version 1 card whose type emoji changed is recomputed and stored as a version 2 fingerprint", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const created = await findProposalForItem(pool, proposalsId, item.id);
      await setProposalFingerprint(created!.id, legacyFingerprintOf("☑️", "Buy milk"));

      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: typesId,
          itemId: type.id,
          propertiesPatch: { emoji: "📌" },
        }),
      );
      let calls = 0;
      await runTick(pool, databaseIds, item.id, async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      });

      expect(calls).toBe(1);
      const revised = await findProposalForItem(pool, proposalsId, item.id);
      expect(revised!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    });
  });

  it.each(["confirmed", "rejected"] as const)(
    "a %s proposal is never modified by a later tick, even when the source changes",
    async (lockedStatus) => {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Task",
          emoji: "☑️",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
      const item = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          journalDatabaseId: journalId,
          timezone: "Europe/Prague",
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
          type: type.id,
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const proposal = await findProposalForItem(pool, proposalsId, item.id);

      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposal!.id,
          propertiesPatch: { status: lockedStatus },
        }),
      );
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: inboxId,
          itemId: item.id,
          propertiesPatch: { text: "Something totally different" },
        }),
      );

      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a locked proposal");
      });

      const stillLocked = await findProposalForItem(pool, proposalsId, item.id);
      expect(stillLocked!.properties.status).toBe(lockedStatus);
      expect(stillLocked!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    },
  );

  it("a soft-deleted existing proposal is treated as absent — a later tick creates a fresh one instead of throwing", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const original = await findProposalForItem(pool, proposalsId, item.id);
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, original!.id));

    // The relation edge to the now-deleted proposal is still there, so this must not throw
    // NotFoundError from trying to update a deleted item — it must fall through and create.
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk (retry)" } }));

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(2);

    const stillDeleted = await itemsStore.getItemById(pool, proposalsId, original!.id);
    expect(stillDeleted!.deletedAt).not.toBeNull();

    // Now two `sourceInbox` edges exist for this item: one to the soft-deleted original, one
    // to the live replacement. A further tick must find the live one regardless of which edge
    // comes back first from the relation lookup — reviving it rather than creating a third row.
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));

    const { rows: afterThirdTick } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    expect(afterThirdTick[0].n).toBe(2);

    const { rows: liveRows } = await pool.query(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
  });

  it("an item with no type is marked needsClarification, not silently skipped (issue #104)", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for an untyped item");
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);
    expect((proposal!.properties.history as Array<Record<string, unknown>>)[0]).toMatchObject({ author: "ai" });
  });

  it("a repeated tick on the same untyped item stays needsClarification without a second history entry", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );

    const throwing: ComputeSemprecProposalFn = async () => {
      throw new Error("computeProposal must not be called for an untyped item");
    };
    await runTick(pool, databaseIds, item.id, throwing);
    await runTick(pool, databaseIds, item.id, throwing);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.history).toHaveLength(1);
  });

  it("never writes a row into any database other than processingProposals", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );

    const tasksDbId = await databaseIdFor("tasks");
    const { rows: before } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      tasksDbId,
    ]);

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    const { rows: after } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      tasksDbId,
    ]);
    expect(after[0].n).toBe(before[0].n);
  });
});

describe("semprec.tick needsClarification, invalid, history, and envelope validation (issue #104)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
    databaseIds = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
  });

  async function createTypedItem(text: string) {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    return { type, item };
  }

  it("a source whose type was deleted out from under it is marked needsClarification, the same path as no type at all", async () => {
    const { type, item } = await createTypedItem("Buy milk");

    await withTransaction(pool, (client) =>
      deleteInboxTypeWithClient(client, {
        inboxDatabaseId: inboxId,
        inboxItemTypesDatabaseId: typesId,
        processingProposalsDatabaseId: proposalsId,
        typeItemId: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called once the type is deleted");
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);
  });

  it("an item that gains a recognized type after needsClarification transitions to proposed on the next tick", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for an untyped item");
    });
    const needsClarification = await findProposalForItem(pool, proposalsId, item.id);
    expect(needsClarification!.properties.status).toBe("needsClarification");
    expect(needsClarification!.properties.fingerprint).toBeNull();

    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    await withTransaction(pool, async (client) => {
      const typeProperty = await propertiesStore.getPropertyByKey(client, inboxId, "type");
      await createRelationWithClient(client, {
        relationPropertyId: typeProperty!.id,
        callerItemId: item.id,
        targetItemId: type.id,
      });
    });

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed!.id).toBe(needsClarification!.id);
    expect(proposed!.properties.status).toBe("proposed");
    expect(proposed!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk" }));
    expect(proposed!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk" },
    });
    expect(proposed!.properties.history).toHaveLength(2);
  });

  it("deleting a source item invalidates its unlocked proposal", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed!.properties.status).toBe("proposed");

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const invalidated = await findProposalForItem(pool, proposalsId, item.id);
    expect(invalidated!.id).toBe(proposed!.id);
    expect(invalidated!.properties.status).toBe("invalid");
    expect(invalidated!.properties.history).toHaveLength(2);
    expect((invalidated!.properties.history as Array<Record<string, unknown>>)[1]).toMatchObject({ author: "ai" });
  });

  it("a confirmed proposal keeps its status when its source item is deleted", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: proposal!.id,
        propertiesPatch: { status: "confirmed" },
      }),
    );

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const stillConfirmed = await findProposalForItem(pool, proposalsId, item.id);
    expect(stillConfirmed!.properties.status).toBe("confirmed");
  });

  it("a rejected proposal keeps its status when its source item is deleted", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: proposal!.id,
        propertiesPatch: { status: "rejected" },
      }),
    );
    const historyLengthBeforeDelete = (proposal!.properties.history as unknown[]).length;

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const stillRejected = await findProposalForItem(pool, proposalsId, item.id);
    expect(stillRejected!.properties.status).toBe("rejected");
    expect((stillRejected!.properties.history as unknown[]).length).toBe(historyLengthBeforeDelete);
  });

  it("deleting a source with no proposal at all is a harmless no-op", async () => {
    const { item } = await createTypedItem("Buy milk");
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));

    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
  });

  it("a proposed envelope naming an unknown property on the target database fails validation and is stored as needsClarification, never as proposed", async () => {
    const { item } = await createTypedItem("Buy milk");

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk", notAKey: "x" } }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);

    const { rows: taskRows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      await databaseIdFor("tasks"),
    ]);
    expect(taskRows[0].n).toBe(0);
  });

  it("a proposed envelope trying to set a relation property directly fails validation", async () => {
    const { item } = await createTypedItem("Buy milk");

    await runTick(pool, databaseIds, item.id, async () => ({
      properties: { name: "Buy milk", project: "some-project-id" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope whose target is not an existing item fails validation", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: "00000000-0000-0000-0000-000000000000",
      properties: { flavour: "paragraph" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope missing block content (flavour) fails validation", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: type.id,
      properties: { note: "no flavour here" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope whose 'fields' is not a plain object fails validation (issue #105 review fix)", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", fields: "not an object" },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a pageContent envelope whose 'children' is not an array of strings fails validation (issue #105 review fix)", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => ({
      target: type.id,
      properties: { flavour: "paragraph", children: [1, 2, 3] },
    }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
  });

  it("a repeated tick with the same invalid envelope does not call computeProposal again", async () => {
    const { item } = await createTypedItem("Buy milk");

    let calls = 0;
    const compute: ComputeSemprecProposalFn = async () => {
      calls++;
      return { properties: { notAKey: "x" } };
    };
    await runTick(pool, databaseIds, item.id, compute);
    await runTick(pool, databaseIds, item.id, compute);
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.history).toHaveLength(1);
  });
});

describe("semprec.tick re-checks the proposal under lock before writing it (issue #662)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
    databaseIds = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
  });

  /** A typed Inbox item with one `proposed` card, then a text edit so the next tick recomputes it. */
  async function seedProposedCardWithChangedSource() {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [proposalsId],
    );
    const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, rows[0]!.id));
    expect(card!.properties.status).toBe("proposed");

    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );
    return { item, card: card! };
  }

  async function readCard(cardId: string) {
    return withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId));
  }

  /**
   * Wraps `pool` so that `beforeLock` runs, and commits on its own connection, right before the
   * tick's first `SELECT ... FOR UPDATE` on `cardId` — the gap between the tick's unlocked
   * snapshot of the card and its locked re-check, on paths that call no `computeProposal`.
   */
  function poolRunningBeforeCardLock(cardId: string, beforeLock: () => Promise<void>): Pool {
    let fired = false;
    return new Proxy(pool, {
      get(t, prop, receiver) {
        if (prop === "connect") {
          return async (...args: unknown[]) => {
            const client = await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
            return new Proxy(client, {
              get(clientTarget, clientProp, clientReceiver) {
                if (clientProp === "query") {
                  return async (...queryArgs: unknown[]) => {
                    const [text, params] = queryArgs as [unknown, unknown];
                    if (
                      !fired &&
                      typeof text === "string" &&
                      text.includes("FOR UPDATE") &&
                      Array.isArray(params) &&
                      params.includes(cardId)
                    ) {
                      fired = true;
                      await beforeLock();
                    }
                    return (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs);
                  };
                }
                return Reflect.get(clientTarget, clientProp, clientReceiver);
              },
            });
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });
  }

  async function rejectCard(cardId: string): Promise<string> {
    const rejected = await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: cardId,
        propertiesPatch: { status: "rejected" },
      }),
    );
    return rejected.updatedAt;
  }

  async function softDeleteCard(cardId: string): Promise<string> {
    const deleted = await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, cardId));
    return deleted!.updatedAt;
  }

  async function softDeleteSource(itemId: string): Promise<void> {
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
  }

  /** A computed envelope naming a property the `tasks` database lacks, so the tick lands in `needsClarification`. */
  const invalidEnvelope = { properties: { noSuchProperty: "x" } };

  it("needsClarification path: a reject committed while the tick computes its proposal wins — the card stays rejected and untouched", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();

    let rejectedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      rejectedVersion = await rejectCard(card.id);
      return invalidEnvelope;
    });

    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(rejectedVersion);
    expect(after!.properties).toEqual({ ...card.properties, status: "rejected" });
  });

  it("needsClarification path: a card soft-deleted while the tick computes its proposal is skipped without writing or throwing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();

    let deletedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      deletedVersion = await softDeleteCard(card.id);
      return invalidEnvelope;
    });

    const after = await readCard(card.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.updatedAt).toBe(deletedVersion);
    expect(after!.properties).toEqual(card.properties);
  });

  it("deleted-source path: a reject committed before the tick locks the card wins — the card is not invalidated", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);

    let rejectedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      rejectedVersion = await rejectCard(card.id);
    });
    await runTick(tickPool, databaseIds, item.id, async () =>
      expect.unreachable("a deleted source is never recomputed"),
    );

    expect(rejectedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(rejectedVersion);
    expect(after!.properties).toEqual({ ...card.properties, status: "rejected" });
  });

  it("deleted-source path: a card soft-deleted before the tick locks it is skipped without writing or throwing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);

    let deletedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      deletedVersion = await softDeleteCard(card.id);
    });
    await runTick(tickPool, databaseIds, item.id, async () =>
      expect.unreachable("a deleted source is never recomputed"),
    );

    expect(deletedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.updatedAt).toBe(deletedVersion);
    expect(after!.properties).toEqual(card.properties);
  });

  it("deleted-source path: a lock failure other than a serialization conflict propagates and writes nothing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);

    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      throw new Error("connection lost while locking the card");
    });
    await expect(
      runTick(tickPool, databaseIds, item.id, async () => expect.unreachable("a deleted source is never recomputed")),
    ).rejects.toThrow("connection lost while locking the card");

    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(card.updatedAt);
    expect(after!.properties).toEqual(card.properties);
  });

  it("a confirm committed while the tick computes its proposal wins — the card stays confirmed and untouched", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    // The tick and the confirm both enqueue the source's Journal-day recompute under the same job
    // key, so a confirm issued from inside the tick would wait on the tick's own transaction. Taking
    // the source off its Journal day leaves the proposal row as the only thing the two contend on.
    await withTransaction(pool, async (client) => {
      const journalDayProperty = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty!.id);
      const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, item.id);
      for (const edge of edges) {
        await relationsStore.deleteItemRelation(client, edge.relationDefinitionId, edge.itemA, edge.itemB);
      }
    });

    let calls = 0;
    await runTick(pool, databaseIds, item.id, async () => {
      calls++;
      await withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, card.id),
      );
      return { properties: { name: "Buy milk and eggs" } };
    });
    expect(calls).toBe(1);

    const after = await readCard(card.id);
    expect(after!.properties.status).toBe("confirmed");
    expect(after!.properties.proposal).toEqual(card.properties.proposal);
    expect(after!.properties.fingerprint).toBe(card.properties.fingerprint);
    const messages = (after!.properties.history as Array<{ message: string }>).map((entry) => entry.message);
    expect(messages).not.toContain("Revised the proposal after the source item changed.");
  });

  it("a card soft-deleted while the tick computes its proposal is skipped without writing or throwing", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();

    let deletedVersion: string | undefined;
    await runTick(pool, databaseIds, item.id, async () => {
      const deleted = await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, proposalsId, card.id));
      deletedVersion = deleted!.updatedAt;
      return { properties: { name: "Buy milk and eggs" } };
    });

    const after = await readCard(card.id);
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.updatedAt).toBe(deletedVersion);
    expect(after!.properties).toEqual(card.properties);
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      proposalsId,
    ]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe("semprec.tick brackets computeProposal outside any transaction (issue #676)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let journalId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    journalId = await databaseIdFor("journal");
  });

  async function createTypedItem(text: string) {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    return { type, item };
  }

  it("holds no transaction and no pooled connection during the computeProposal call", async () => {
    const { item } = await createTypedItem("Buy milk");

    // A dedicated single-connection pool: if the tick still held its transaction's one
    // connection open across `computeProposal`, this query — issued from inside the fake
    // while it runs — would have no connection to acquire and would never resolve.
    const tickPool = getTestPool({ max: 1 });
    try {
      const handler = createSemprecTickAction(tickPool, async (input) => {
        await Promise.race([
          tickPool.query("SELECT 1"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("computeProposal: no free pooled connection")), 2000),
          ),
        ]);
        expect(input.entityKind).toBe("database");
        return { properties: { name: "Buy milk" } };
      });
      await handler(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
      );
    } finally {
      await tickPool.end();
    }

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.status).toBe("proposed");
  }, 10000);

  it("writes nothing for a stale envelope when the source changes during computeProposal, and the next tick produces the card for the new fingerprint", async () => {
    const { type, item } = await createTypedItem("Buy milk");

    const handler = createSemprecTickAction(pool, async () => {
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: inboxId,
          itemId: item.id,
          propertiesPatch: { text: "Buy milk and eggs" },
        }),
      );
      return { properties: { name: "Buy milk" } };
    });
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );

    expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();

    let calls = 0;
    const handlerAgain = createSemprecTickAction(pool, async () => {
      calls++;
      return { properties: { name: "Buy milk and eggs" } };
    });
    await handlerAgain(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    expect(calls).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal).toBeTruthy();
    expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
  });

  it("a proposal created by a second tick while the first is still in computeProposal is revised, not duplicated (issue #792 review fix)", async () => {
    const { item } = await createTypedItem("Buy milk");

    // Neither tick sees the other's proposal in its read snapshot: A's snapshot read happens
    // before B runs to completion inside A's computeProposal, and B's own snapshot read happens
    // while A hasn't written anything yet. So both reach `writeTickResult` believing
    // `snapshot.existingProposal` is null — the exact race `raceProposal` exists to catch.
    const handlerA = createSemprecTickAction(pool, async () => {
      const handlerB = createSemprecTickAction(pool, async () => ({ properties: { name: "Buy milk (from B)" } }));
      await handlerB(
        { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
        { heartbeatId: "hb-b", projectItemId: "proj", itemId: item.id },
      );
      return { properties: { name: "Buy milk (from A)" } };
    });
    await handlerA(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb-a", projectItemId: "proj", itemId: item.id },
    );

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [proposalsId]);
    expect(rows[0].n).toBe(1);

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.status).toBe("proposed");
    expect(proposal!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk (from A)" },
    });
    expect(proposal!.properties.history).toHaveLength(2);
  });
});

describe("assertValidProposalEnvelope resolves the target database row (issue #735)", () => {
  let typesId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    typesId = await databaseIdFor("inboxItemTypes");
  });

  it("resolves to the target database row for a valid 'database' envelope", async () => {
    const tasksDbId = await databaseIdFor("tasks");

    const targetDatabase = await withTransaction(pool, (client) =>
      assertValidProposalEnvelope(client, {
        entityKind: "database",
        target: tasksDbId,
        properties: { name: "Buy milk" },
      }),
    );

    expect(targetDatabase).not.toBeNull();
    expect(targetDatabase!.id).toBe(tasksDbId);
  });

  it("resolves to null for a valid 'pageContent' envelope", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "💭",
        processingMethod: "pageContent",
      }),
    );

    const targetDatabase = await withTransaction(pool, (client) =>
      assertValidProposalEnvelope(client, {
        entityKind: "pageContent",
        target: type.id,
        properties: { flavour: "paragraph" },
      }),
    );

    expect(targetDatabase).toBeNull();
  });
});

describe("assertValidProposalEnvelope validates envelope relations (issue #1426)", () => {
  let tasksDbId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    tasksDbId = await databaseIdFor("tasks");
  });

  async function createProject(properties: Record<string, unknown>): Promise<string> {
    const projectsId = await databaseIdFor("projects");
    return withTransaction(
      pool,
      async (client) => (await createItemWithClient(client, { databaseId: projectsId, properties })).id,
    );
  }

  function validate(relations: Record<string, string[]>, entityKind: "database" | "pageContent" = "database") {
    return withTransaction(pool, (client) =>
      assertValidProposalEnvelope(client, {
        entityKind,
        target: tasksDbId,
        properties: entityKind === "database" ? { name: "Buy milk" } : { flavour: "paragraph" },
        relations,
      }),
    );
  }

  it("keeps stored relations when the envelope is parsed", async () => {
    const project = await createProject({ name: "Home" });
    const stored = {
      entityKind: "database",
      target: tasksDbId,
      properties: { name: "x" },
      relations: { project: [project] },
    };

    expect(parseStoredProposalEnvelope(stored, "proposal-id")).toEqual(stored);
  });

  it("accepts an existing project and an empty array meaning no edge", async () => {
    const project = await createProject({ name: "Home" });
    const done = await createProject({ name: "Late invoice", status: "done" });

    await expect(validate({ project: [project] })).resolves.not.toBeNull();
    await expect(validate({ project: [done] })).resolves.not.toBeNull();
    await expect(validate({ project: [] })).resolves.not.toBeNull();
  });

  it("rejects a nonexistent target with the relation key as field", async () => {
    const error = await validate({ project: ["00000000-0000-4000-8000-000000000001"] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(400);
    expect((error as ValidationError).details).toMatchObject({ field: "project" });
  });

  it("rejects an archived project with targetArchived", async () => {
    const project = await createProject({ name: "Old", status: "archived" });

    const error = await validate({ project: [project] }).catch((e: unknown) => e);

    expect((error as ValidationError).details).toEqual({ field: "project", code: "targetArchived" });
  });

  it("rejects a key that is not a relation property and a duplicated target", async () => {
    const project = await createProject({ name: "Home" });

    const notRelation = await validate({ name: [project] }).catch((e: unknown) => e);
    const unknown = await validate({ nope: [project] }).catch((e: unknown) => e);
    const duplicate = await validate({ project: [project, project] }).catch((e: unknown) => e);

    for (const [error, field] of [
      [notRelation, "name"],
      [unknown, "nope"],
      [duplicate, "project"],
    ] as const) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({ field });
    }
  });

  it("rejects relations on a pageContent envelope", async () => {
    const error = await validate({ project: [] }, "pageContent").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toEqual({ field: "relations" });
  });
});

describe("assertValidProposalEnvelope validates multi-step envelopes (issue #1479)", () => {
  let peopleDbId: string;
  let companiesDbId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    peopleDbId = await databaseIdFor("people");
    companiesDbId = await databaseIdFor("companies");
  });

  const companyStep = {
    ref: "company",
    op: "create" as const,
    databaseKey: "companies",
    properties: { name: "Acme" },
    role: "secondary" as const,
  };
  const personStep = {
    ref: "person",
    op: "create" as const,
    databaseKey: "people",
    properties: { name: "Jane" },
    relations: { companies: [{ ref: "company" }] },
    role: "primary" as const,
  };

  function envelopeOf(operations: ProposalStep[], primary = operations.find((s) => s.role === "primary")!) {
    return {
      entityKind: "database" as const,
      target: primary.databaseKey === "people" ? peopleDbId : companiesDbId,
      properties: primary.properties ?? {},
      operations,
    };
  }

  function validate(envelope: ProposalEnvelope) {
    return withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
  }

  async function failure(envelope: ProposalEnvelope): Promise<ValidationError> {
    const error = await validate(envelope).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }

  async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
    const databaseId = await databaseIdFor(moduleId);
    return withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id);
  }

  it("parses and validates a company plus a new person", async () => {
    const stored = envelopeOf([companyStep, personStep]);

    const parsed = parseStoredProposalEnvelope(JSON.parse(JSON.stringify(stored)), "p1") as ProposalEnvelope;

    expect(parsed.operations).toEqual(stored.operations);
    expect((await validate(parsed))!.id).toBe(peopleDbId);
  });

  it("leaves a single-step envelope byte for byte unchanged by parse and stringify", () => {
    const stored = {
      entityKind: "database",
      target: peopleDbId,
      properties: { name: "Jane" },
      relations: { companies: ["a"] },
    };
    const json = JSON.stringify(stored);

    expect(JSON.stringify(parseStoredProposalEnvelope(JSON.parse(json), "p1"))).toBe(json);
  });

  it("reports the ref and field of a failing step", async () => {
    const error = await failure(envelopeOf([{ ...companyStep, properties: { name: "Acme", bogus: 1 } }, personStep]));

    expect(error.details).toEqual({ ref: "company", field: "bogus" });
  });

  it("rejects a cycle between steps", async () => {
    const error = await failure(
      envelopeOf([{ ...companyStep, relations: { people: [{ ref: "person" }] } }, personStep]),
    );

    expect(error.details).toMatchObject({ field: expect.any(String) });
    expect(error.message).toContain("cycle");
  });

  it("rejects a ref to a missing step", async () => {
    const error = await failure(envelopeOf([{ ...personStep, relations: { companies: [{ ref: "nope" }] } }]));

    expect(error.details).toEqual({ ref: "person", field: "companies" });
  });

  it("rejects two primary steps and duplicate refs", async () => {
    const twoPrimaries = await failure(envelopeOf([{ ...companyStep, role: "primary" }, personStep], personStep));
    const duplicate = await failure(envelopeOf([{ ...companyStep, ref: "person" }, personStep]));

    expect(twoPrimaries.details).toMatchObject({ field: "role" });
    expect(duplicate.details).toEqual({ ref: "person", field: "ref" });
  });

  it("rejects a primary step that differs from the top level", async () => {
    const envelope = { ...envelopeOf([companyStep, personStep]), properties: { name: "Other" } };

    expect((await failure(envelope)).details).toEqual({ ref: "person", field: "properties" });
  });

  it("ignores a disabled step with an invalid payload", async () => {
    const disabled = { ...companyStep, enabled: false, properties: { bogus: 1 } };

    await validate(envelopeOf([disabled, { ...personStep, relations: undefined }]));
  });

  it("ignores an optional step nobody refers to, but validates it once referred to", async () => {
    const optional = { ...companyStep, optional: true, properties: { bogus: 1 } };

    await validate(envelopeOf([optional, { ...personStep, relations: undefined }]));
    const error = await failure(envelopeOf([optional, personStep]));

    expect(error.details).toEqual({ ref: "company", field: "bogus" });
  });

  it("skips an optional step that refers to a disabled step, but rejects a required one", async () => {
    const disabled = { ...companyStep, enabled: false };
    const optionalReferrer = {
      ref: "second",
      op: "create" as const,
      databaseKey: "companies",
      properties: { bogus: 1 },
      relations: { people: [{ ref: "company" }] },
      role: "secondary" as const,
      optional: true,
    };

    await validate(envelopeOf([disabled, optionalReferrer, { ...personStep, relations: undefined }]));
    const error = await failure(envelopeOf([disabled, personStep]));

    expect(error.details).toEqual({ ref: "person", field: "companies" });
  });

  describe("update steps", () => {
    async function updateEnvelope(step: Partial<ProposalStep>, itemId: string, moduleId = "projects") {
      const primary: ProposalStep = {
        ref: "move",
        op: "update",
        itemId,
        properties: step.properties ?? {},
        role: "primary",
        ...step,
      };
      return {
        entityKind: "database" as const,
        target: await databaseIdFor(moduleId),
        properties: primary.properties ?? {},
        operations: [primary],
      };
    }

    it("accepts an update step changing a project's status", async () => {
      const project = await createItem("projects", { name: "Home", status: "inProgress" });

      await validate(
        await updateEnvelope(
          {
            properties: { status: "done" },
            before: { properties: { status: "inProgress" } },
            after: { properties: { status: "done" } },
          },
          project,
        ),
      );
    });

    it("accepts an update step moving a project to another area", async () => {
      const oldArea = await createItem("areas", { name: "Old" });
      const newArea = await createItem("areas", { name: "New" });
      const project = await createItem("projects", { name: "Home" });

      await validate(
        await updateEnvelope(
          {
            relations: { area: [newArea] },
            before: { relations: { area: [oldArea] } },
            after: { relations: { area: [newArea] } },
          },
          project,
        ),
      );
    });

    it("rejects a system-owned property with the step's ref and field", async () => {
      const task = await createItem("tasks", { name: "Buy milk" });

      const error = await failure(
        await updateEnvelope(
          { properties: { time: "x" }, before: { properties: { time: null } }, after: { properties: { time: "x" } } },
          task,
          "tasks",
        ),
      );

      expect(error.details).toEqual({ ref: "move", field: "time" });
    });

    it("rejects a changed key that is missing from before", async () => {
      const project = await createItem("projects", { name: "Home", status: "inProgress" });

      const error = await failure(
        await updateEnvelope(
          { properties: { status: "done" }, before: {}, after: { properties: { status: "done" } } },
          project,
        ),
      );

      expect(error.details).toEqual({ ref: "move", field: "status" });
    });

    it("rejects an item that does not exist", async () => {
      const error = await failure(
        await updateEnvelope({ properties: { status: "done" } }, "00000000-0000-4000-8000-000000000001"),
      );

      expect(error.details).toEqual({ ref: "move", field: "itemId" });
    });
  });
});

afterAll(async () => {
  await pool?.end();
});
