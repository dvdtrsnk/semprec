import { z } from "zod";
import "../domainWriteHooks.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { AiGatewayFailedError, type AiGatewayFailureReason, runInTenant } from "@semprec/shared";
import { createUser } from "../auth/usersStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
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
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { registerItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import {
  aiProposalPatch,
  assertValidProposalEnvelope,
  createSemprecTickAction,
  parseStoredProposalEnvelope,
  readAiProposal,
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
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
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

  describe("untyped recognition", () => {
    async function fixture() {
      const type = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Recognized task",
          status: "active",
          emoji: "T",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
      const item = await withTransaction(pool, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: inboxId,
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
        }),
      );
      return { type, item };
    }
    it.each(["type", "direct"])(
      "recognizes a %s candidate without writing the source type and reuses the fingerprint",
      async (kind) => {
        const { type, item } = await fixture();
        let calls = 0;
        const compute: ComputeSemprecProposalFn = async (input) => {
          calls++;
          expect(input.recognition).toBe(true);
          return {
            properties: { name: "Buy milk" },
            candidates: [
              kind === "type" ? { typeId: type.id, confidence: 0.9 } : { targetDatabaseKey: "tasks", confidence: 0.9 },
            ],
          };
        };
        await runTick(pool, databaseIds, item.id, compute);
        const card = await findProposalForItem(pool, proposalsId, item.id);
        expect(card?.properties).toMatchObject({
          status: "proposed",
          recognizedTypeId: kind === "type" ? type.id : null,
          typeCandidates: [],
          fingerprint: fingerprintV2Of({ typeId: "", text: "Buy milk" }),
        });
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: item.id,
            propertiesPatch: { date: "2026-08-28" },
          }),
        );
        await runTick(pool, databaseIds, item.id, compute);
        expect(calls).toBe(1);
        expect(await findProposalForItem(pool, proposalsId, item.id)).toEqual(card);
        const property = await withTransaction(pool, (client) =>
          propertiesStore.getPropertyByKey(client, inboxId, "type"),
        );
        if (!property) throw new Error("Missing type property");
        const definition = await withTransaction(pool, (client) =>
          relationsStore.getRelationDefinitionByPropertyId(client, property.id),
        );
        if (!definition) throw new Error("Missing type definition");
        expect(
          await withTransaction(pool, (client) => relationsStore.listRelationsForItem(client, definition.id, item.id)),
        ).toEqual([]);
      },
    );
    it.each(["type", "direct"])("reruns %s recognition after text changes", async (kind) => {
      const { type, item } = await fixture();
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return {
          properties: { name: "Task" },
          candidates: [
            kind === "type" ? { typeId: type.id, confidence: 0.7 } : { targetDatabaseKey: "tasks", confidence: 0.7 },
          ],
        };
      };
      await runTick(pool, databaseIds, item.id, compute);
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Buy eggs" } }),
      );
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties).toMatchObject({
        status: "proposed",
        recognizedTypeId: kind === "type" ? type.id : null,
        typeCandidates: [],
      });
    });
    it("offers padded distinct candidates and the model reason below threshold", async () => {
      const { type, item } = await fixture();
      const second = await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Alternative task",
          status: "active",
          emoji: "A",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: {},
        reason: "Choose a type",
        candidates: [
          { typeId: type.id, confidence: 0.5 },
          { typeId: "unknown", confidence: 1 },
        ],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      expect(card?.properties).toMatchObject({ status: "needsClarification", recognizedTypeId: null, proposal: null });
      const choices = z.array(z.object({ typeId: z.string() })).parse(card?.properties.typeCandidates);
      expect(choices.map((choice) => choice.typeId)).toEqual([type.id, second.id]);
      expect(card?.properties.reason).toBe("Choose a type");
      expect(new Set(choices.map((choice) => choice.typeId)).size).toBe(choices.length);
      expect(choices.map((choice) => choice.typeId)).not.toContain("unknown");
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: inboxId,
          itemId: item.id,
          propertiesPatch: { text: "A different uncertain item" },
        }),
      );
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: {},
        candidates: [{ typeId: second.id, confidence: 0.5 }],
        reason: "Another choice",
      }));
      const revised = await findProposalForItem(pool, proposalsId, item.id);
      expect(revised?.id).toBe(card?.id);
      expect(revised?.properties).toMatchObject({
        status: "needsClarification",
        recognizedTypeId: null,
        reason: "Another choice",
        typeCandidates: [{ typeId: second.id }, { typeId: type.id }],
      });
    });
    it("discards recognition when text changes during the call", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => {
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Changed" } }),
        );
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
    });
    it.each(["date", "time", "attachment"])("reruns recognition after a %s change", async (field) => {
      const { type, item } = await fixture();
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Task" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      };
      await runTick(pool, databaseIds, item.id, compute);
      if (field === "attachment") {
        const blob = await createBlob(pool, {
          mimeType: "image/png",
          byteSize: 1,
          storageKey: "recognition-attachment",
          contentHash: "a".repeat(64),
        });
        await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
      } else
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: inboxId,
            itemId: item.id,
            propertiesPatch: field === "date" ? { date: "2026-08-29" } : { time: "10:00" },
          }),
        );
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
    });
    it("keeps legacy v1 compatibility for an untyped source", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: { name: "Task" },
        candidates: [{ typeId: type.id, confidence: 0.9 }],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      if (!card) throw new Error("Missing card");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: proposalsId,
            itemId: card.id,
            propertiesPatch: { fingerprint: legacyFingerprintOf("", "Buy milk") },
          },
          { allowedSystemKeys: ["fingerprint"] },
        ),
      );
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("Unchanged legacy source must not compute");
      });
    });
    it("discards recognition after a source type-edge change", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => {
        await withTransaction(pool, async (client) => {
          const property = await propertiesStore.getPropertyByKey(client, inboxId, "type");
          if (!property) throw new Error("Missing type property");
          await createRelationWithClient(client, {
            relationPropertyId: property.id,
            callerItemId: item.id,
            targetItemId: type.id,
          });
        });
        return { properties: { name: "Stale" }, candidates: [{ typeId: type.id, confidence: 0.9 }] };
      });
      expect(await findProposalForItem(pool, proposalsId, item.id)).toBeNull();
    });
    it("never recomputes a locked recognized card", async () => {
      const { type, item } = await fixture();
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: { name: "Task" },
        candidates: [{ typeId: type.id, confidence: 0.9 }],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      if (!card) throw new Error("Missing card");
      await withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: proposalsId, itemId: card.id, propertiesPatch: { status: "rejected" } },
          { allowedSystemKeys: ["status"] },
        ),
      );
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "Changed" } }),
      );
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("Locked card must not compute");
      });
    });
    it.each([0, 1])("offers only %s existing valid types and explains the shortage", async (count) => {
      const { type, item } = await fixture();
      const types = await withTransaction(pool, (client) => itemsStore.listItems(client, typesId, { limit: 200 }));
      for (const row of types.items) {
        if (count === 1 && row.id === type.id) continue;
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: typesId,
            itemId: row.id,
            propertiesPatch: { status: "archived" },
          }),
        );
      }
      await runTick(pool, databaseIds, item.id, async () => ({
        properties: {},
        candidates: [{ typeId: type.id, confidence: count === 0 ? 0.9 : 0.5 }],
      }));
      const card = await findProposalForItem(pool, proposalsId, item.id);
      expect(card?.properties.status).toBe("needsClarification");
      expect(card?.properties.proposal).toBeNull();
      expect(z.array(z.unknown()).parse(card?.properties.typeCandidates)).toHaveLength(count);
      expect(card?.properties.reason).toEqual(expect.any(String));
    });
    it("makes no call without text", async () => {
      const { item } = await fixture();
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, { databaseId: inboxId, itemId: item.id, propertiesPatch: { text: "" } }),
      );
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("Unexpected computation");
      });
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.status).toBe("needsClarification");
    });
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
          date: "2026-08-28",
          time: "09:00",
          text: "Buy milk",
          type: type.id,
        }),
      );
      return item.id;
    }

    it.each(["cs", "en", "fr"] as const)(
      "passes the %s user's locale and replaces the reason on recompute",
      async (locale) => {
        await runInTenant(getTenantZeroId(), () =>
          createUser(pool, { email: `${locale}@example.com`, passwordHash: "x", locale, tenantId: getTenantZeroId() }),
        );
        const itemId = await createTaskInboxItem();
        await runInTenant(getTenantZeroId(), () =>
          runTick(pool, databaseIds, itemId, async (input) => {
            expect(input.locale).toBe(locale);
            return { properties: { name: "Buy milk" }, reason: "  Úkol s termínem.  " };
          }),
        );
        const card = await findProposalForItem(pool, proposalsId, itemId);
        expect(card?.properties.reason).toBe("Úkol s termínem.");
        await withTransaction(pool, (client) =>
          updateItemWithClient(client, { databaseId: inboxId, itemId, propertiesPatch: { text: "Buy eggs" } }),
        );
        await runInTenant(getTenantZeroId(), () =>
          runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Buy eggs" }, reason: "Nový úkol." })),
        );
        expect((await findProposalForItem(pool, proposalsId, itemId))?.properties.reason).toBe("Nový úkol.");
      },
    );
    it.each([
      [undefined, null],
      ["", null],
      ["   ", null],
      ["x".repeat(501), "x".repeat(500)],
    ] as const)("normalizes reason %s", async (reason, expected) => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Task" }, reason }));
      const card = await findProposalForItem(pool, proposalsId, itemId);
      expect(card?.properties.reason).toBe(expected);
    });

    it("clears the model reason when the source is deleted", async () => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Task" }, reason: "A task." }));
      await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
      await runTick(pool, databaseIds, itemId, async () => {
        throw new Error("Deleted source must not compute");
      });
      expect((await findProposalForItem(pool, proposalsId, itemId))?.properties).toMatchObject({
        status: "invalid",
        reason: null,
      });
    });
    it("does not store the reason of an invalid computed proposal", async () => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({
        properties: { notAProperty: true },
        reason: "Discard me",
      }));
      expect((await findProposalForItem(pool, proposalsId, itemId))?.properties).toMatchObject({
        status: "needsClarification",
        reason: null,
      });
    });
    it("refuses a client write of reason", async () => {
      const itemId = await createTaskInboxItem();
      await runTick(pool, databaseIds, itemId, async () => ({ properties: { name: "Task" }, reason: "Original" }));
      const card = await findProposalForItem(pool, proposalsId, itemId);
      if (!card) throw new Error("Missing proposal");
      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: proposalsId,
            itemId: card.id,
            propertiesPatch: { reason: "Changed" },
          }),
        ),
      ).rejects.toMatchObject({ code: "owner_violation" });
      expect((await findProposalForItem(pool, proposalsId, itemId))?.properties.reason).toBe("Original");
    });
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

    it("uses legacy blob IDs for missing hashes on add, reorder and removal at an invoked tick", async () => {
      const type = await createInboxType("Task", "☑️");
      const item = await createInboxItemOfType("Buy milk", type.id);
      let calls = 0;
      const compute: ComputeSemprecProposalFn = async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      };
      await runTick(pool, databaseIds, item.id, compute);
      const first = await createBlob(pool, {
        mimeType: "image/jpeg",
        byteSize: 1,
        storageKey: `legacy/${randomUUID()}`,
      });
      const second = await createBlob(pool, {
        mimeType: "image/jpeg",
        byteSize: 1,
        storageKey: `legacy/${randomUUID()}`,
      });
      await insertInboxAttachments(pool, item.id, [
        { blobId: first.id, source: "camera" },
        { blobId: second.id, source: "camera" },
      ]);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      const before = await findProposalForItem(pool, proposalsId, item.id);
      expect(before?.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [first.id, second.id] }),
      );
      await detachBlob(item.id, first.id);
      await insertInboxAttachments(pool, item.id, [{ blobId: first.id, source: "camera" }]);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(2);
      expect((await findProposalForItem(pool, proposalsId, item.id))?.updatedAt).toBe(before?.updatedAt);
      await detachBlob(item.id, second.id);
      await runTick(pool, databaseIds, item.id, compute);
      expect(calls).toBe(3);
      expect((await findProposalForItem(pool, proposalsId, item.id))?.properties.fingerprint).toBe(
        fingerprintV2Of({ typeId: type.id, text: "Buy milk", attachmentHashes: [first.id] }),
      );
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
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
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
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );

    const throwing: ComputeSemprecProposalFn = async () => {
      return { properties: {}, candidates: [] };
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
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
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
      return { properties: {}, candidates: [] };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: "", text: "Buy milk" }));
    expect(proposal!.properties.status).toBe("needsClarification");
    expect(proposal!.properties.proposal).toBeNull();
    expect(proposal!.properties.history).toHaveLength(1);
  });

  it("an item that gains a recognized type after needsClarification transitions to proposed on the next tick", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );

    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });
    const needsClarification = await findProposalForItem(pool, proposalsId, item.id);
    expect(needsClarification!.properties.status).toBe("needsClarification");
    expect(needsClarification!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: "", text: "Buy milk" }));

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
    expect((invalidated!.properties.history as Array<Record<string, unknown>>)[1]).toMatchObject({
      author: "ai",
      kind: "invalidated",
    });
    expect(invalidated!.properties.invalidReason).toEqual({
      code: "sourceDeleted",
      field: "",
      itemId: item.id,
      label: "Buy milk",
    });
  });

  it("a deleted source's reason label is its trimmed first line, cut by code point to 80 characters", async () => {
    // Emoji are two UTF-16 units each: a cut by unit would split one at the 79th position.
    const longFirstLine = `  ${"🙂".repeat(120)}  `;
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
        date: "2026-08-28",
        time: "09:00",
        text: `${longFirstLine}\nsecond line`,
        type: type.id,
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Long" } }));
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const invalidated = await findProposalForItem(pool, proposalsId, item.id);
    const reason = invalidated!.properties.invalidReason as { label: string };
    expect(reason.label).toBe(`${"🙂".repeat(79)}…`);
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

  // Restoring a source returns its `sourceDeleted` card (issue #1604). Each test trashes and restores with the
  // store calls, so the tick runs explicitly here; the heartbeat that runs it is covered in inboxTick.test.ts.
  async function trashSource(itemId: string): Promise<void> {
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
  }

  async function restoreSource(itemId: string): Promise<void> {
    await withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, itemId));
  }

  it("restoring an unchanged source returns its invalid card to proposed with no reason and no recompute", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
    });

    const reopened = await findProposalForItem(pool, proposalsId, item.id);
    expect(reopened!.id).toBe(proposed!.id);
    expect(reopened!.properties.status).toBe("proposed");
    expect(reopened!.properties.invalidReason).toBeNull();
    expect(reopened!.properties.proposal).toEqual(proposed!.properties.proposal);
    expect(reopened!.properties.history).toHaveLength(3);
    expect((reopened!.properties.history as Array<Record<string, unknown>>)[2]).toMatchObject({
      author: "ai",
      kind: "reopened",
    });
  });

  it("a source whose text changed before it was trashed is recomputed when it is restored", async () => {
    const { type, item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: inboxId,
        itemId: item.id,
        propertiesPatch: { text: "Buy milk and eggs" },
      }),
    );
    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await restoreSource(item.id);

    const computedFor: unknown[] = [];
    await runTick(pool, databaseIds, item.id, async (input) => {
      computedFor.push(input.sourceItem.properties.text);
      return { properties: { name: "Buy milk and eggs" } };
    });

    expect(computedFor).toEqual(["Buy milk and eggs"]);
    const recomputed = await findProposalForItem(pool, proposalsId, item.id);
    expect(recomputed!.properties.status).toBe("proposed");
    expect(recomputed!.properties.invalidReason).toBeNull();
    expect(recomputed!.properties.fingerprint).toBe(fingerprintV2Of({ typeId: type.id, text: "Buy milk and eggs" }));
    expect(recomputed!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
  });

  it("a restored card whose stored envelope no longer validates goes to needsClarification, keeping its fingerprint", async () => {
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
        date: "2026-08-28",
        time: "09:00",
        text: "A thought",
        type: type.id,
      }),
    );
    // Any existing item is a valid page target until it is trashed, so the envelope's page can go missing.
    const page = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "The page",
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => ({
      target: page.id,
      properties: { flavour: "paragraph", fields: { content: "A thought" } },
    }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposed!.properties.status).toBe("proposed");

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, page.id));
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
    });

    const card = await findProposalForItem(pool, proposalsId, item.id);
    expect(card!.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
      invalidReason: null,
      fingerprint: proposed!.properties.fingerprint,
    });
  });

  it("a restored source with no recognized type makes its invalid card needsClarification with no reason", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    expect((await findProposalForItem(pool, proposalsId, item.id))!.properties.invalidReason).toMatchObject({
      code: "sourceDeleted",
    });

    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const card = await findProposalForItem(pool, proposalsId, item.id);
    expect(card!.properties).toMatchObject({ status: "needsClarification", invalidReason: null });
    expect(card!.properties.history).toHaveLength(3);
  });

  it("a card invalid for targetArchived is not touched when its source is deleted and restored", async () => {
    const { item } = await createTypedItem("Buy milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const proposed = await findProposalForItem(pool, proposalsId, item.id);
    const reason = {
      code: "targetArchived",
      field: "target",
      itemId: await databaseIdFor("tasks"),
      label: "Tasks",
    };
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, {
        databaseId: proposalsId,
        itemId: proposed!.id,
        propertiesPatch: { status: "invalid", invalidReason: reason },
      }),
    );
    const before = await findProposalForItem(pool, proposalsId, item.id);

    await trashSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });
    await restoreSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called when the source fingerprint is unchanged");
    });

    const after = await findProposalForItem(pool, proposalsId, item.id);
    expect(after!.properties.status).toBe("invalid");
    expect(after!.properties.invalidReason).toEqual(reason);
    expect(after!.properties.history).toEqual(before!.properties.history);
  });

  it.each(["confirmed", "rejected"] as const)(
    "a %s card keeps its status and history when its source is deleted and restored",
    async (status) => {
      const { item } = await createTypedItem("Buy milk");
      await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
      const proposal = await findProposalForItem(pool, proposalsId, item.id);
      await withTransaction(pool, (client) =>
        itemsStore.updateItemProperties(client, {
          databaseId: proposalsId,
          itemId: proposal!.id,
          propertiesPatch: { status },
        }),
      );
      const before = await findProposalForItem(pool, proposalsId, item.id);

      await trashSource(item.id);
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a deleted source");
      });
      await restoreSource(item.id);
      await runTick(pool, databaseIds, item.id, async () => {
        throw new Error("computeProposal must not be called for a locked card");
      });

      const after = await findProposalForItem(pool, proposalsId, item.id);
      expect(after!.properties).toEqual(before!.properties);
    },
  );

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
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
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

  it("restored-source path: a reject committed before the tick locks the card wins — the card is not reopened (issue #1604)", async () => {
    const { item, card } = await seedProposedCardWithChangedSource();
    await softDeleteSource(item.id);
    await runTick(pool, databaseIds, item.id, async () => expect.unreachable("a deleted source is never recomputed"));
    await withTransaction(pool, (client) => itemsStore.restoreItem(client, inboxId, item.id));
    const invalid = await readCard(card.id);
    expect(invalid!.properties.status).toBe("invalid");

    let rejectedVersion: string | undefined;
    const tickPool = poolRunningBeforeCardLock(card.id, async () => {
      rejectedVersion = await rejectCard(card.id);
    });
    await runTick(tickPool, databaseIds, item.id, async () =>
      expect.unreachable("a card that lost the lock is not recomputed"),
    );

    expect(rejectedVersion).toBeDefined();
    const after = await readCard(card.id);
    expect(after!.updatedAt).toBe(rejectedVersion);
    expect(after!.properties).toEqual({ ...invalid!.properties, status: "rejected" });
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

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
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

describe("semprec.tick records a failed proposal computation on the card (issue #1485)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    databaseIds = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
  });

  /** A typed Inbox item (a 'database' type targeting `tasks`) with the text `Buy milk`. */
  async function createTypedItem(): Promise<{ itemId: string; typeId: string }> {
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
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
        type: type.id,
      }),
    );
    return { itemId: item.id, typeId: type.id };
  }

  /** One attempt of the tick with a stubbed computation; `isFinalAttempt` is what the heartbeat fire task passes. */
  function attempt(itemId: string, computeProposal: ComputeSemprecProposalFn, isFinalAttempt: boolean): Promise<void> {
    return createSemprecTickAction(pool, computeProposal)(databaseIds, {
      heartbeatId: "hb",
      projectItemId: "proj",
      itemId,
      isFinalAttempt,
    });
  }

  /** A computation that fails with the gateway's own error for `reason`. */
  function failingWith(reason: AiGatewayFailureReason): ComputeSemprecProposalFn {
    return async () => {
      throw new AiGatewayFailedError(reason);
    };
  }

  /** A concurrent source edit: the text changes, so the source's fingerprint no longer matches the snapshot. */
  async function editSourceText(itemId: string, text: string): Promise<void> {
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch: { text } }),
    );
  }

  it("a budget rejection creates a computeFailed card naming the reason, and the tick does not throw", async () => {
    const { itemId } = await createTypedItem();

    let calls = 0;
    await expect(
      attempt(
        itemId,
        async () => {
          calls++;
          throw new AiGatewayFailedError("budget_exceeded");
        },
        false,
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);

    const card = await findProposalForItem(pool, proposalsId, itemId);
    expect(card).toBeTruthy();
    expect(card!.properties.status).toBe("computeFailed");
    expect(card!.properties.fingerprint ?? null).toBeNull();
    expect(card!.properties.proposal ?? null).toBeNull();
    expect(card!.properties.history).toEqual([
      expect.objectContaining({ author: "ai", message: "Computing the proposal failed: budget_exceeded." }),
    ]);
  });

  it.each(["timeout", "http", "invalid_response"] as const)(
    "a %s failure on a non-final attempt rethrows so the queue retries, and writes no card",
    async (reason) => {
      const { itemId } = await createTypedItem();

      await expect(attempt(itemId, failingWith(reason), false)).rejects.toThrow(`AI gateway call failed: ${reason}`);
      expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
    },
  );

  it.each(["timeout", "http", "invalid_response"] as const)(
    "a %s failure on the final attempt records the card and does not throw",
    async (reason) => {
      const { itemId } = await createTypedItem();

      await expect(attempt(itemId, failingWith(reason), true)).resolves.toBeUndefined();

      const card = await findProposalForItem(pool, proposalsId, itemId);
      expect(card!.properties.status).toBe("computeFailed");
      expect(card!.properties.history).toEqual([
        expect.objectContaining({ author: "ai", message: `Computing the proposal failed: ${reason}.` }),
      ]);
    },
  );

  it("an error that is not a gateway failure propagates even on the final attempt, and writes nothing", async () => {
    const { itemId } = await createTypedItem();

    await expect(
      attempt(
        itemId,
        async () => {
          throw new Error("the answer did not match the schema");
        },
        true,
      ),
    ).rejects.toThrow("the answer did not match the schema");
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it("an item edited while the failing call is in flight writes no card, even on the final attempt", async () => {
    const { itemId } = await createTypedItem();

    await expect(
      attempt(
        itemId,
        async () => {
          await editSourceText(itemId, "Buy milk and eggs");
          throw new AiGatewayFailedError("timeout");
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it("an item deleted while the failing call is in flight writes no card", async () => {
    const { itemId } = await createTypedItem();

    await expect(
      attempt(
        itemId,
        async () => {
          await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, itemId));
          throw new AiGatewayFailedError("timeout");
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(await findProposalForItem(pool, proposalsId, itemId)).toBeNull();
  });

  it.each(["confirmed", "rejected"] as const)(
    "a card that became %s while the failing call was in flight stays untouched",
    async (lockedStatus) => {
      const { itemId } = await createTypedItem();
      await attempt(itemId, async () => ({ properties: { name: "Buy milk" } }), false);
      const proposed = (await findProposalForItem(pool, proposalsId, itemId))!;
      expect(proposed.properties.status).toBe("proposed");
      await editSourceText(itemId, "Buy milk and eggs");

      await expect(
        attempt(
          itemId,
          async () => {
            await withTransaction(pool, (client) =>
              itemsStore.updateItemProperties(client, {
                databaseId: proposalsId,
                itemId: proposed.id,
                propertiesPatch: { status: lockedStatus },
              }),
            );
            throw new AiGatewayFailedError("timeout");
          },
          true,
        ),
      ).resolves.toBeUndefined();

      const after = await findProposalForItem(pool, proposalsId, itemId);
      expect(after!.properties.status).toBe(lockedStatus);
      expect(after!.properties.history).toEqual(proposed.properties.history);
    },
  );

  it("a card that already exists keeps its proposal and gains the failure entry", async () => {
    const { itemId } = await createTypedItem();
    await attempt(itemId, async () => ({ properties: { name: "Buy milk" } }), false);
    const proposed = (await findProposalForItem(pool, proposalsId, itemId))!;
    await editSourceText(itemId, "Buy milk and eggs");

    await attempt(itemId, failingWith("timeout"), true);

    const card = (await findProposalForItem(pool, proposalsId, itemId))!;
    expect(card.id).toBe(proposed.id);
    expect(card.properties.status).toBe("computeFailed");
    expect(card.properties.fingerprint ?? null).toBeNull();
    expect(card.properties.proposal).toEqual(proposed.properties.proposal);
    expect(card.properties.history).toEqual([
      ...(proposed.properties.history as unknown[]),
      expect.objectContaining({ author: "ai", message: "Computing the proposal failed: timeout." }),
    ]);
  });

  it("the next successful tick after a failure makes the card proposed with a fresh fingerprint", async () => {
    const { itemId, typeId } = await createTypedItem();
    await attempt(itemId, failingWith("budget_exceeded"), false);

    // The source did not change, but a null fingerprint is never current, so the tick computes again.
    let calls = 0;
    await attempt(
      itemId,
      async () => {
        calls++;
        return { properties: { name: "Buy milk" } };
      },
      false,
    );
    expect(calls).toBe(1);

    const card = await findProposalForItem(pool, proposalsId, itemId);
    expect(card!.properties.status).toBe("proposed");
    expect(card!.properties.fingerprint).toBe(fingerprintV2Of({ typeId, text: "Buy milk" }));
    expect(card!.properties.proposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk" },
    });
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
    if (!(error instanceof ValidationError)) throw error;
    return error;
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

  it("reports the ref and field of a failing person step", async () => {
    const error = await failure(envelopeOf([companyStep, { ...personStep, properties: { name: "Jane", bogus: 1 } }]));

    expect(error.status).toBe(400);
    expect(error.details).toEqual({ ref: "person", field: "bogus" });
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

  it("rejects a forged link before list that names a missing target", async () => {
    const person = await createItem("people", { name: "Jane" });
    const missing = "00000000-0000-4000-8000-000000000001";
    const error = await failure(
      envelopeOf([
        { ...companyStep, role: "primary" },
        {
          ref: "person",
          op: "link",
          role: "secondary",
          itemId: person,
          relations: { companies: [missing] },
          before: { relations: { companies: [missing] } },
        },
      ]),
    );
    expect(error.details).toMatchObject({ ref: "person", field: "companies" });
  });

  it("rejects two primary steps and duplicate refs", async () => {
    const twoPrimaries = await failure(envelopeOf([{ ...companyStep, role: "primary" }, personStep], personStep));
    const duplicate = await failure(envelopeOf([{ ...companyStep, ref: "person" }, personStep]));

    expect(twoPrimaries.details).toMatchObject({ field: "role" });
    expect(duplicate.details).toEqual({ ref: "person", field: "ref" });
  });

  it("enforces proposal identity and primary invariants on skipped steps", async () => {
    const active = { ...personStep, relations: undefined };
    for (const skipped of [
      { ...companyStep, enabled: false, ref: "person" },
      { ...companyStep, optional: true, ref: "person" },
      { ...companyStep, enabled: false, ref: "" },
    ]) {
      expect((await failure(envelopeOf([active, skipped]))).details).toMatchObject({ field: "ref" });
    }
    const primary = { ...companyStep, enabled: false, role: "primary" as const };
    expect((await failure(envelopeOf([active, primary], active))).details).toMatchObject({ field: "role" });
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

  it.each(["missing", "company"])("ignores a bad %s reference on an unreferenced optional step", async (ref) => {
    const optional = { ...companyStep, optional: true, relations: { people: [{ ref }] } };
    await validate(envelopeOf([optional, { ...personStep, relations: undefined }]));
  });

  it("rejects a required step referring to an optional step skipped for a missing reference", async () => {
    const optional = { ...companyStep, optional: true, relations: { people: [{ ref: "missing" }] } };
    const error = await failure(envelopeOf([optional, personStep]));
    expect(error.details).toEqual({ ref: "person", field: "companies" });
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
    it("prepares a project pin without taking its allocation lock", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const envelope = await updateEnvelope(
        {
          properties: { pinned: true },
          before: { properties: { pinned: false, pinnedOrder: null } },
          after: { properties: { pinned: true } },
        },
        project,
      );
      await withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          await assertValidProposalEnvelope(client, envelope);
          expect(
            spy.mock.calls.some((args) => typeof args[0] === "string" && args[0].includes("projects-pinned-order")),
          ).toBe(false);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("validates an explicit pin order and rejects a conflicting after value", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const step: Partial<ProposalStep> = {
        properties: { pinned: true, pinnedOrder: 7 },
        before: { properties: { pinned: false, pinnedOrder: null } },
        after: { properties: { pinned: true, pinnedOrder: 7 } },
      };
      await validate(await updateEnvelope(step, project));
      const error = await failure(
        await updateEnvelope({ ...step, after: { properties: { pinned: true, pinnedOrder: 8 } } }, project),
      );
      expect(error.details).toEqual({ ref: "move", field: "pinnedOrder" });
    });

    it("rejects a predicted after value for an implicitly allocated pin order", async () => {
      const project = await createItem("projects", { name: "Project", pinned: false });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { pinned: true },
            before: { properties: { pinned: false, pinnedOrder: null } },
            after: { properties: { pinned: true, pinnedOrder: 1 } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "pinnedOrder" });
    });

    it("validates a Books year through its registered preparation", async () => {
      const book = await createItem("books", { name: "Book" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { year: "invalid" },
            before: { properties: { year: null } },
            after: { properties: { year: "invalid" } },
          },
          book,
          "books",
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field: "year" });
    });

    it("fails closed without invoking an unprepared registered transform", async () => {
      const chokePoint = createChokePoint(pool);
      const database = await chokePoint.createDatabase({
        name: "Preparation fixture",
        ownerModuleId: "unpreparedFixture",
      });
      await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "text" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { name: "Before" } });
      let calls = 0;
      registerItemPreWriteTransform("unpreparedFixture", async ({ patch }) => {
        calls++;
        return patch;
      });
      const error = await failure({
        entityKind: "database",
        target: database.id,
        properties: { name: "After" },
        operations: [
          {
            ref: "item",
            op: "update",
            role: "primary",
            itemId: item.id,
            properties: { name: "After" },
            before: { properties: { name: "Before" } },
            after: { properties: { name: "After" } },
          },
        ],
      });
      expect(error.details).toEqual({ ref: "item", field: "properties" });
      expect(calls).toBe(0);
    });

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

    it("rejects a missing step referenced only by an update's after relations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope({ after: { relations: { area: [{ ref: "missing" }] } } }, project),
      );
      expect(error.details).toEqual({ ref: "move", field: "area" });
    });

    it("rejects a cycle through an update's after relations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const envelope = await updateEnvelope({ after: { relations: { area: [{ ref: "area" }] } } }, project);
      envelope.operations.push({
        ref: "area",
        op: "create",
        databaseKey: "areas",
        role: "secondary",
        properties: { name: "Work" },
        relations: { projects: [{ ref: "move" }] },
      });
      const error = await failure(envelope);
      expect(error.details).toMatchObject({ ref: "area", field: "projects" });
    });

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

    it("rejects a blank title with the update field and ref", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { name: "" },
            before: { properties: { name: "Home" } },
            after: { properties: { name: "" } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "name" });
    });

    it.each([
      [{ date: "2026-02-30" }, { date: null }, "date"],
      [{ timeFrom: "10:00" }, { timeFrom: null }, "timeFrom"],
    ])("rejects an invalid Tasks schedule through its registered preparation", async (patch, before, field) => {
      const task = await createItem("tasks", { name: "Task" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: patch,
            before: { properties: before },
            after: { properties: patch },
          },
          task,
          "tasks",
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field });
    });

    it("rejects an after-only relation with no before coverage", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(await updateEnvelope({ after: { relations: { area: [] } } }, project));
      expect(error.details).toEqual({ ref: "move", field: "area" });
    });

    it("rejects a conflicting after property", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { name: "Next" },
            before: { properties: { name: "Home" } },
            after: { properties: { name: "Other" } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "name" });
    });

    it("rejects an unsupported redundant after property", async () => {
      const project = await createItem("projects", { name: "Home", pinned: false });
      const error = await failure(
        await updateEnvelope(
          {
            properties: { name: "Next" },
            before: { properties: { name: "Home", pinned: false } },
            after: { properties: { name: "Next", pinned: false } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "pinned" });
    });

    it("rejects conflicting relation representations", async () => {
      const project = await createItem("projects", { name: "Home" });
      const first = await createItem("areas", { name: "First" });
      const second = await createItem("areas", { name: "Second" });
      const error = await failure(
        await updateEnvelope(
          {
            relations: { area: [first] },
            before: { relations: { area: [] } },
            after: { relations: { area: [second] } },
          },
          project,
        ),
      );
      expect(error.details).toEqual({ ref: "move", field: "area" });
    });

    it("rejects an invalid after-only relation target", async () => {
      const project = await createItem("projects", { name: "Home" });
      const error = await failure(
        await updateEnvelope(
          {
            before: { relations: { area: [] } },
            after: { relations: { area: ["00000000-0000-4000-8000-000000000001"] } },
          },
          project,
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field: "area" });
    });

    it("does not treat a forged update before target as an existing edge", async () => {
      const project = await createItem("projects", { name: "Home" });
      const missing = "00000000-0000-4000-8000-000000000001";
      const error = await failure(
        await updateEnvelope(
          {
            before: { relations: { area: [missing] } },
            after: { relations: { area: [missing] } },
          },
          project,
        ),
      );
      expect(error.details).toMatchObject({ ref: "move", field: "area" });
    });

    it("validates an actually retained edge and rejects its archived or deleted target", async () => {
      const project = await createItem("projects", { name: "Project", status: "inProgress" });
      const task = await createItem("tasks", { name: "Task" });
      const tasksDb = await databaseIdFor("tasks");
      const databaseIdForProject = await databaseIdFor("projects");
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, tasksDb, "project"),
      );
      if (!property) throw new Error("Missing Tasks.project");
      await withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: task,
          targetItemId: project,
        }),
      );
      const envelope = await updateEnvelope(
        {
          before: { relations: { project: [project] } },
          after: { relations: { project: [project] } },
        },
        task,
        "tasks",
      );
      await validate(envelope);
      await withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: databaseIdForProject,
          itemId: project,
          propertiesPatch: { status: "archived" },
        }),
      );
      expect((await failure(envelope)).details).toMatchObject({
        ref: "move",
        field: "project",
        code: "targetArchived",
      });
      await createChokePoint(pool).softDeleteItem(databaseIdForProject, project);
      expect((await failure(envelope)).details).toMatchObject({ ref: "move", field: "project", code: "targetDeleted" });
    });

    it("exempts only the retained edge from target-side cardinality", async () => {
      const first = await createItem("projects", { name: "First" });
      const second = await createItem("projects", { name: "Second" });
      const task = await createItem("tasks", { name: "Task" });
      const projectsDb = await databaseIdFor("projects");
      const property = await withTransaction(pool, (client) =>
        propertiesStore.getPropertyByKey(client, projectsDb, "tasks"),
      );
      if (!property) throw new Error("Missing Projects.tasks");
      await withTransaction(pool, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: first,
          targetItemId: task,
        }),
      );
      const step = { before: { relations: { tasks: [task] } }, after: { relations: { tasks: [task] } } };
      await validate(await updateEnvelope(step, first));
      await expect(validate(await updateEnvelope(step, second))).rejects.toMatchObject({
        status: 409,
        details: { ref: "move", field: "tasks" },
      });
    });

    it("rejects a foreign-tenant target under the runtime role even if before claims it", async () => {
      const foreignTenant = await createTestTenant(pool);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        await runInTenant(foreignTenant, () => seedSystem(runtime, createViewTypeRegistry()));
        const foreignProject = await runInTenant(foreignTenant, () =>
          withTransaction(runtime, async (client) => {
            const database = await client.query<{ id: string }>(
              "SELECT id FROM databases WHERE owner_module_id = 'projects'",
            );
            if (!database.rows[0]) throw new Error("Missing foreign Projects database");
            return (
              await createItemWithClient(client, { databaseId: database.rows[0].id, properties: { name: "Foreign" } })
            ).id;
          }),
        );
        const task = await createItem("tasks", { name: "Task" });
        const envelope = await updateEnvelope(
          { before: { relations: { project: [foreignProject] } }, after: { relations: { project: [foreignProject] } } },
          task,
          "tasks",
        );
        await expect(
          withTenantTransaction(runtime, getTenantZeroId(), (client) => assertValidProposalEnvelope(client, envelope)),
        ).rejects.toMatchObject({ status: 400, details: { ref: "move", field: "project" } });
      } finally {
        await runtime.end();
      }
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

describe("aiProposal and aiVersion on the tick's writes (issue #1471)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;
  let databaseIds: TickDatabaseIds;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    databaseIds = {
      inboxDatabaseId: inboxId,
      inboxItemTypesDatabaseId: typesId,
      processingProposalsDatabaseId: proposalsId,
    };
  });

  async function createTaskType() {
    return withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
  }

  async function createTaskItem(text: string, typeId: string) {
    return withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: typeId,
      }),
    );
  }

  async function editText(itemId: string, text: string) {
    await withTransaction(pool, (client) =>
      itemsStore.updateItemProperties(client, { databaseId: inboxId, itemId, propertiesPatch: { text } }),
    );
  }

  it("the tick's create stores aiProposal equal to proposal at aiVersion 1", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);

    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties.proposal).toBeTruthy();
    expect(proposal!.properties.aiProposal).toEqual(proposal!.properties.proposal);
    expect(proposal!.properties.aiVersion).toBe(1);
  });

  it("a recompute after a source change stores the new envelope at aiVersion 2, and the next one at 3", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));

    await editText(item.id, "Buy milk and eggs");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));
    const second = await findProposalForItem(pool, proposalsId, item.id);
    expect(second!.properties.aiProposal).toEqual({
      entityKind: "database",
      target: await databaseIdFor("tasks"),
      properties: { name: "Buy milk and eggs" },
    });
    expect(second!.properties.aiProposal).toEqual(second!.properties.proposal);
    expect(second!.properties.aiVersion).toBe(2);

    await editText(item.id, "Buy oat milk");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy oat milk" } }));
    const third = await findProposalForItem(pool, proposalsId, item.id);
    expect(third!.properties.aiProposal).toEqual(third!.properties.proposal);
    expect(third!.properties.aiVersion).toBe(3);
  });

  it("an untyped item's needsClarification stores null aiProposal and aiVersion 1", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "no type",
      }),
    );
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const proposal = await findProposalForItem(pool, proposalsId, item.id);
    expect(proposal!.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 1,
    });
  });

  it("a needsClarification written over an existing card nulls aiProposal and counts one more version", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const before = await findProposalForItem(pool, proposalsId, item.id);
    expect(before!.properties.aiVersion).toBe(1);

    // Taking the type off the item makes it untyped, so the tick writes needsClarification over the card.
    await withTransaction(pool, async (client) => {
      const typeProperty = await propertiesStore.getPropertyByKey(client, inboxId, "type");
      await deleteRelationWithClient(client, {
        relationPropertyId: typeProperty!.id,
        callerItemId: item.id,
        targetItemId: type.id,
      });
    });
    await runTick(pool, databaseIds, item.id, async () => {
      return { properties: {}, candidates: [] };
    });

    const after = await findProposalForItem(pool, proposalsId, item.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.properties).toMatchObject({
      status: "needsClarification",
      proposal: null,
      aiProposal: null,
      aiVersion: 2,
    });
  });

  it("invalidating a card for a deleted source leaves its aiProposal and aiVersion as they were", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const before = await findProposalForItem(pool, proposalsId, item.id);

    await withTransaction(pool, (client) => itemsStore.softDeleteItem(client, inboxId, item.id));
    await runTick(pool, databaseIds, item.id, async () => {
      throw new Error("computeProposal must not be called for a deleted source");
    });

    const invalidated = await findProposalForItem(pool, proposalsId, item.id);
    expect(invalidated!.properties.status).toBe("invalid");
    expect(invalidated!.properties.aiProposal).toEqual(before!.properties.aiProposal);
    expect(invalidated!.properties.aiVersion).toBe(1);
  });

  it("a legacy card without aiProposal reads its proposal, and its next automated write sets aiProposal at aiVersion 1", async () => {
    const type = await createTaskType();
    const item = await createTaskItem("Buy milk", type.id);
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk" } }));
    const created = await findProposalForItem(pool, proposalsId, item.id);

    // A card written before aiProposal and aiVersion existed: no current writer can produce that state.
    await pool.query("UPDATE items SET properties = properties - 'aiProposal' - 'aiVersion' WHERE id = $1", [
      created!.id,
    ]);
    const legacy = await findProposalForItem(pool, proposalsId, item.id);
    expect(legacy!.properties).not.toHaveProperty("aiProposal");
    expect(legacy!.properties).not.toHaveProperty("aiVersion");
    expect(readAiProposal(legacy!.properties, legacy!.id)).toEqual(created!.properties.proposal);

    await editText(item.id, "Buy milk and eggs");
    await runTick(pool, databaseIds, item.id, async () => ({ properties: { name: "Buy milk and eggs" } }));

    const revised = await findProposalForItem(pool, proposalsId, item.id);
    expect(revised!.properties.aiProposal).toEqual(revised!.properties.proposal);
    expect(revised!.properties.aiVersion).toBe(1);
  });
});

describe("aiProposalPatch and readAiProposal (issue #1471)", () => {
  const envelope: ProposalEnvelope = {
    entityKind: "database",
    target: "00000000-0000-4000-8000-000000000001",
    properties: { name: "Buy milk" },
  };
  const otherEnvelope: ProposalEnvelope = { ...envelope, properties: { name: "Buy eggs" } };

  it("a new row starts at aiVersion 1, a row with a counter adds one, and a row without one counts as 0", () => {
    expect(aiProposalPatch({}, envelope)).toEqual({ aiProposal: envelope, aiVersion: 1 });
    expect(aiProposalPatch({ aiVersion: 4 }, null)).toEqual({ aiProposal: null, aiVersion: 5 });
  });

  it("readAiProposal returns aiProposal when it is set, even where proposal differs", () => {
    expect(readAiProposal({ aiProposal: envelope, proposal: otherEnvelope }, "card")).toEqual(envelope);
  });

  it("readAiProposal falls back to the stored proposal when aiProposal is absent or JSON null", () => {
    expect(readAiProposal({ proposal: envelope }, "card")).toEqual(envelope);
    expect(readAiProposal({ aiProposal: null, proposal: envelope }, "card")).toEqual(envelope);
  });

  it("readAiProposal returns null when neither property holds an envelope", () => {
    expect(readAiProposal({}, "card")).toBeNull();
    expect(readAiProposal({ aiProposal: null, proposal: null }, "card")).toBeNull();
  });
});

afterAll(async () => {
  await pool?.end();
});
