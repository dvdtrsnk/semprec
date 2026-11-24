// Assembles the Overview summary from each owner's counting function; counts nothing itself.
import type { Pool } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { listAllDatabases } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { countOpenInboxCards } from "../inbox/inboxCardsStore.js";
import { createCollectionMetadataResolver, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { countUnreadInboxThreads } from "../mail/mailSummary.js";
import { readSempStatusSummary } from "../semp/sempStatusSummary.js";

interface OverviewCollection {
  databaseId: string;
  ownerModuleId: string;
}

/** `GET /api/overview`. */
export interface OverviewSummary {
  inboxPending: number;
  mailUnread: number;
  /** The client-visible system databases, in `listAllDatabases` order. */
  collections: OverviewCollection[];
  problemCount: number;
}

export interface OverviewSummaryInput {
  /** From the session; the Inbox count includes this user's pending approvals. */
  ownerUserId: string;
}

let collectionMetadataResolverPromise: Promise<CollectionMetadataResolver> | undefined;

/**
 * Built once per process because the custom-route factory receives only the pool, not the composition root's
 * registry. A failed build is not cached, so the next request retries.
 */
function getCollectionMetadataResolver(): Promise<CollectionMetadataResolver> {
  collectionMetadataResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCollectionMetadataResolver(registry))
    .catch((error: unknown) => {
      collectionMetadataResolverPromise = undefined;
      throw error;
    });
  return collectionMetadataResolverPromise;
}

/**
 * Each number comes from the same function its owner's route calls, all in one READ COMMITTED transaction on one
 * connection, so numbers may be read at slightly different moments. An unscoped call throws so it can never look like
 * an empty tenant.
 */
export async function getOverviewSummary(pool: Pool, input: OverviewSummaryInput): Promise<OverviewSummary> {
  if (currentTenantScope()?.kind !== "tenant") throw new Error("getOverviewSummary requires an active tenant scope");
  const resolver = await getCollectionMetadataResolver();

  return withTransaction(pool, async (client) => {
    const collections = (await listAllDatabases(client)).flatMap((database) =>
      database.ownerModuleId !== null && resolver.resolve(database).clientVisible
        ? [{ databaseId: database.id, ownerModuleId: database.ownerModuleId }]
        : [],
    );
    const inboxPending = await countOpenInboxCards(client, { ownerUserId: input.ownerUserId });
    const mailUnread = await countUnreadInboxThreads(client);
    const problemCount = (await readSempStatusSummary(client)).activeCount;
    return { inboxPending, mailUnread, collections, problemCount };
  });
}
