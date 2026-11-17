import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import {
  AiGatewayFailedError,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";
import { createBlob, recordDetectedBlobMimeType, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { insertInboxAttachments, recordInboxAttachmentMetadata } from "../inbox/inboxAttachmentsStore.js";
import type { ProposalComputationInput } from "../inbox/inboxTickSnapshot.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { INBOX_ITEM_TYPES_MODULE_ID, INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import type { ItemRow } from "../types.js";

// Recipe proposal fixtures: an Inbox item typed to Recipes with its photos, plus gateway and outbound-client fakes.

export const RECIPE_GATEWAY_OPERATION = "inbox_proposal";

/** Answers each call with `answer(callNumber)`; a throw is a failed call. Every call is recorded. */
export interface ScriptedGateway extends AiGatewayClientPort {
  readonly calls: AiGatewayCompletionInput[];
}

export function scriptedGateway(answer: (callNumber: number) => unknown): ScriptedGateway {
  const calls: AiGatewayCompletionInput[] = [];
  return {
    calls,
    complete(input): Promise<AiGatewayCompletionResult> {
      calls.push(input);
      try {
        return Promise.resolve({ content: answer(calls.length), usage: { inputTokens: 1, outputTokens: 1 } });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("The scripted gateway failed"));
      }
    },
  };
}

export const failingGateway = (reason: "timeout" | "http" | "budget_exceeded" | "invalid_response") =>
  scriptedGateway(() => {
    throw new AiGatewayFailedError(reason);
  });

export const GOULASH_ANSWER = {
  name: "Beef goulash",
  ingredients: ["600 g beef chuck", "2 onions", "1 tbsp paprika"],
  steps: ["Brown the onions.", "Add the beef and paprika.", "Simmer for two hours."],
  prepMinutes: 150,
  servings: 4,
  photoUrl: null,
};

export type FakeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** `routes` maps a URL to its response; any other URL fails. */
export interface RoutedFetch {
  readonly fetch: FakeFetch;
  /** In request order. */
  readonly requested: string[];
}

export function routedFetch(routes: Readonly<Record<string, () => Response>>): RoutedFetch {
  const requested: string[] = [];
  return {
    requested,
    fetch(url) {
      const key = String(url);
      requested.push(key);
      const route = routes[key];
      return route ? Promise.resolve(route()) : Promise.reject(new TypeError("fetch failed"));
    },
  };
}

export const htmlPage = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

/** A PNG signature plus a few bytes, enough for the blob store's content classification. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

export interface RecipeInboxFixture {
  itemId: string;
  typeId: string;
  recipesDatabaseId: string;
  inboxDatabaseId: string;
  /** The input the tick hands to the computation. */
  input: ProposalComputationInput;
  /** In attach order. */
  attachmentIds: string[];
  attachmentBlobIds: string[];
}

export interface PhotoFixture {
  /** The reduced copy the model reads. */
  reduced: { bytes: Buffer; mimeType: string } | null;
  blobMimeType?: string;
  /** The verified type the Inbox judges the blob by, instead of the stored one. */
  blobDetectedMimeType?: string;
}

/**
 * An Inbox item with `text`, typed to Recipes, plus the input the tick would compute it with. Each photo is
 * attached with metadata; its reduced copy (unless `reduced` is null) is written to `storage`. All writes go through
 * the owning stores; the original blob is a row without bytes, since only the reduced copy is read.
 */
export async function createRecipeInboxItem(
  dataPool: Pool,
  storage: BlobStorageWriter,
  tenantId: string,
  options: { text: string; locale?: string; photos?: readonly PhotoFixture[] },
): Promise<RecipeInboxFixture> {
  return runInTenant(tenantId, async () => {
    const chokePoint = createChokePoint(dataPool);
    const { inboxDatabaseId, typesDatabaseId, recipesDatabaseId } = await withTransaction(dataPool, async (client) => {
      const databaseId = async (moduleId: string) => {
        const database = await getDatabaseByModuleId(client, moduleId);
        if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
        return database.id;
      };
      return {
        inboxDatabaseId: await databaseId(INBOX_MODULE_ID),
        typesDatabaseId: await databaseId(INBOX_ITEM_TYPES_MODULE_ID),
        recipesDatabaseId: await databaseId(RECIPES_MODULE_ID),
      };
    });
    const type = await chokePoint.createItem({
      databaseId: typesDatabaseId,
      properties: {
        name: "Recipe",
        emoji: "🍲",
        processingMethod: "database",
        targetDatabase: RECIPES_MODULE_ID,
      },
    });
    const item = await chokePoint.createItem({
      databaseId: inboxDatabaseId,
      properties: { text: options.text, date: "2026-11-15", time: "12:30" },
    });
    // The `type` edge the tick reads the item's type from.
    const typeProperty = await withTransaction(dataPool, (client) => getPropertyByKey(client, inboxDatabaseId, "type"));
    if (!typeProperty) throw new Error("The Inbox database has no 'type' property");
    await chokePoint.createRelation({
      relationPropertyId: typeProperty.id,
      callerItemId: item.id,
      targetItemId: type.id,
    });
    const attachmentIds: string[] = [];
    const attachmentBlobIds: string[] = [];
    for (const photo of options.photos ?? []) {
      const attached = await withTransaction(dataPool, async (client) => {
        const blob = await createBlob(client, {
          mimeType: photo.blobMimeType ?? "image/jpeg",
          byteSize: 1,
          storageKey: await tenantBlobStorageKey(client, `blobs/${randomUUID()}`),
        });
        if (photo.blobDetectedMimeType) await recordDetectedBlobMimeType(client, blob.id, photo.blobDetectedMimeType);
        const [attachmentId] = await insertInboxAttachments(client, item.id, [{ blobId: blob.id, source: "camera" }]);
        if (attachmentId === undefined) throw new Error("No attachment was inserted");
        let reduced = null;
        if (photo.reduced) {
          const storageKey = await tenantBlobStorageKey(client, `inbox-attachments/${randomUUID()}.jpg`);
          const written = await storage.writeStream(storageKey, Readable.from([photo.reduced.bytes]));
          reduced = {
            mimeType: photo.reduced.mimeType,
            byteSize: written.byteSize,
            storageKey,
            contentHash: written.contentHash,
          };
        }
        await recordInboxAttachmentMetadata(client, {
          attachmentId,
          metadata: { width: 100, height: 80, pages: null },
          thumbnail: null,
          reduced,
        });
        return { attachmentId, blobId: blob.id };
      });
      attachmentIds.push(attached.attachmentId);
      attachmentBlobIds.push(attached.blobId);
    }
    const { sourceItem, typeItem } = await withTransaction(dataPool, async (client) => {
      const sourceItem = await getItemById(client, inboxDatabaseId, item.id);
      const typeItem = await getItemById(client, typesDatabaseId, type.id);
      if (!sourceItem || !typeItem) throw new Error("The fixture items were not found");
      return { sourceItem, typeItem };
    });
    return {
      itemId: item.id,
      typeId: type.id,
      recipesDatabaseId,
      inboxDatabaseId,
      attachmentIds,
      attachmentBlobIds,
      input: {
        sourceItem: sourceItem satisfies ItemRow,
        type: typeItem,
        entityKind: "database",
        targetDatabaseId: recipesDatabaseId,
        targetModuleId: RECIPES_MODULE_ID,
        locale: options.locale ?? "en",
        projectItemId: randomUUID(),
      },
    };
  });
}
