// Owns the choke point's item writes: `createItem` / `updateItem` and their transaction-scoped
// `createItemWithClient` / `updateItemWithClient` counterparts, the property writability checks
// they share, the archived-database create guard with its idempotent-replay exception, the inline
// derivation of Tasks `time`, and `writeComputedAndAnnounce`. It does not own item reads
// (itemReads.ts), trash and restore (itemTrash.ts), or relation writes (relationOps.ts).
// Constrained by:
// - docs/adr/2026-09-19-derived-system-properties-computed-inline-at-choke-point.md
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow, PropertyRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import { findDependenciesBySource } from "../rollup/dependencies.js";
import { enqueueRollupRecompute } from "../rollup/recompute.js";
import { triggerOnItemEventHeartbeats, recomputeAllForTimezoneChange } from "../scheduler/schedulerStore.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";
import { assertValidTimezone } from "../timezone.js";
import { getSystemSettingsItemId } from "../systemSettings.js";
import { deriveTaskTime } from "../tasks/deriveTaskTime.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { recordDesiredMailMessageFlags } from "../mail/mailMessageFlagSyncStore.js";

interface AssertWritablePropertiesOptions {
  /**
   * Relaxes the owner:'system' rejection below, but only for the exact keys listed — the one
   * narrow escape hatch for a trusted, code-defined system writer that is itself the module
   * contract's declared owning process for those specific fields (e.g. Journal's lazy item
   * creation is the owning process for exactly `name`/`type`/`period`, see
   * journal/journalStore.ts). Scoped per-key, not a blanket bypass, so a caller can't
   * accidentally (or a future caller couldn't deliberately) use it to write a *different*
   * database's system-owned field it was never granted. Never set from a request-handling path.
   */
  allowedSystemKeys?: readonly string[];
  /** The identity of a trusted in-process system writer, required to match each system field it writes. */
  systemOwnerProcess?: string;
}

/** Keys the generic write path never accepts: relation values live only in item_relations, and computed is internal-only. */
function assertWritableProperties(
  properties: PropertyRow[],
  patchKeys: string[],
  options: AssertWritablePropertiesOptions = {},
): void {
  const byKey = new Map(properties.map((p) => [p.key, p]));
  for (const key of patchKeys) {
    const property = byKey.get(key);
    if (!property) {
      throw new ValidationError(`Unknown property key '${key}'`, { field: key });
    }
    if (property.type === "rollup") {
      // Rollup values live in items.computed, written only by the recompute worker —
      // matches the issue's "the generic update path refuses this field — computed_readonly, 403".
      throw new ForbiddenError(
        `Property '${key}' is a rollup; its value lives in computed and is read-only here`,
        { field: key },
        "computed_readonly",
      );
    }
    if (property.type === "relation") {
      throw new ValidationError(
        `Property '${key}' is a relation; write it via createRelation/deleteRelation, not item properties`,
        {
          field: key,
        },
      );
    }
    if (property.owner === "system") {
      if (!options.allowedSystemKeys?.includes(key)) {
        throw new ForbiddenError(`Property '${key}' is owned by 'system' and cannot be written by this caller`, {
          field: key,
        });
      }
      if (options.systemOwnerProcess && property.ownerProcess !== options.systemOwnerProcess) {
        throw new ForbiddenError(
          `Property '${key}' is not owned by this system process`,
          { field: key },
          "owner_violation",
        );
      }
    }
  }
}

/**
 * Item creation's own archived-database guard: unlike every other mutation, a create must let
 * through the one no-write exception the issue carves out — a replay of an idempotency key
 * that already committed a row before the database was archived returns that existing row
 * instead of failing, so a retried request doesn't turn a transient error into a permanent
 * failure. A new key, or a key reserved for this database whose row is somehow missing (see
 * the same defensive branch in `itemsStore.insertItem`), still gets `database_archived` — only
 * an exact, already-satisfied replay is spared. Returns the replay row to return verbatim (no
 * further writes or event emission), or `null` when the database isn't archived at all.
 */
async function assertDatabaseWritableForCreate(
  client: PoolClient,
  databaseId: string,
  idempotencyKey: string | undefined,
): Promise<ItemRow | null> {
  const database = await databasesStore.getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (!database.archivedAt) return null;

  if (idempotencyKey) {
    const replay = await itemsStore.findIdempotentReplay(client, databaseId, idempotencyKey);
    if (replay) return replay;
  }
  throw new ForbiddenError(
    `Database ${databaseId} is archived and cannot be written to`,
    { field: "databaseId" },
    "database_archived",
  );
}

export interface CreateItemWithClientOptions extends AssertWritablePropertiesOptions {
  /** Queue affinity to route the onItemEvent heartbeat-fire job to, looked up by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
  /** The user whose write this is, when there is one — see `InvalidationEvent`'s doc comment. Absent for a system/background caller. */
  actingUserId?: string;
}

export interface CreateItemInput {
  databaseId: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * The item-creation logic, factored out (same reason as `createRelationPropertyWithClient`
 * above) so a caller already holding an open transaction can run it against that same
 * `client` — namely `tasks/advanceTaskRecurrence.ts`, whose rolling-model advance must create
 * the next task instance, mark the old one done, and re-link its relations as a single
 * all-or-nothing transaction, and `journal/journalStore.ts`, whose lazy item creation writes
 * owner:'system' properties (`allowedSystemKeys`) as Journal's declared owning process for
 * exactly those keys. `createChokePoint(...)`'s `createItem` below is a thin wrapper over this.
 */
export async function createItemWithClient(
  client: PoolClient,
  input: CreateItemInput,
  options: CreateItemWithClientOptions = {},
): Promise<ItemRow> {
  const replay = await assertDatabaseWritableForCreate(client, input.databaseId, input.idempotencyKey);
  if (replay) return replay;

  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  assertWritableProperties(properties, Object.keys(input.properties ?? {}), options);

  const database = await databasesStore.getDatabase(client, input.databaseId);
  if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  const inputProperties = input.properties ?? {};
  // Ownership-keyed derived property, distinct from the allowedSystemKeys escape hatch above —
  // see docs/adr/2026-09-19-derived-system-properties-computed-inline-at-choke-point.md.
  const itemProperties =
    database.ownerModuleId === TASKS_MODULE_ID
      ? {
          ...inputProperties,
          time: deriveTaskTime(
            typeof inputProperties.timeFrom === "string" ? inputProperties.timeFrom : null,
            typeof inputProperties.timeTo === "string" ? inputProperties.timeTo : null,
          ),
        }
      : inputProperties;

  const item = await itemsStore.insertItem(client, {
    databaseId: input.databaseId,
    properties: itemProperties,
    idempotencyKey: input.idempotencyKey,
  });
  await triggerOnItemEventHeartbeats(client, input.databaseId, "create", item.id, options.queueAffinity);
  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: item.databaseId,
      itemId: item.id,
      op: "create",
      updatedAt: item.updatedAt,
      userId: options.actingUserId,
    }),
  );
  return item;
}

/**
 * `itemsStore.writeComputed` for a declared module cache writer whose computed value the UI
 * shows live (the transcription worker's Transcripts `segments`/`language`/summaries): writes
 * the key inside the caller's transaction, then announces it over the generic realtime channel
 * once that transaction commits — `writeComputed` alone announces nothing. The announced
 * `updatedAt` is the one the write itself read back, not a caller's earlier snapshot.
 */
export async function writeComputedAndAnnounce(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const updatedAt = await itemsStore.writeComputed(client, databaseId, itemId, key, value);
  runAfterCommit(client, () => notifyInvalidation({ scope: "item", databaseId, itemId, op: "update", updatedAt }));
}

export interface UpdateItemInput {
  databaseId: string;
  itemId: string;
  propertiesPatch: Record<string, unknown>;
  ifVersion?: string;
}

export interface UpdateItemWithClientOptions extends AssertWritablePropertiesOptions {
  /** Queue affinity to route the onItemEvent heartbeat-fire job to, looked up by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
  /** The user whose write this is, when there is one — see `InvalidationEvent`'s doc comment. Absent for a system/background caller. */
  actingUserId?: string;
}

/**
 * The item-update logic, factored out for the same reason as `createItemWithClient` above.
 * `options.allowedSystemKeys` (issue #25) mirrors `createItemWithClient`'s escape hatch: a
 * declared owning process — e.g. the library metadata heartbeat writing `cover` after an
 * item already exists — needs to patch its owner:'system' fields post-creation, not only
 * at insert time. `createChokePoint(...).updateItem` below never passes it, same as
 * `createItem`'s public wrapper.
 */
export async function updateItemWithClient(
  client: PoolClient,
  input: UpdateItemInput,
  options: UpdateItemWithClientOptions = {},
): Promise<ItemRow> {
  await assertDatabaseNotArchived(client, input.databaseId);
  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  const patchKeys = Object.keys(input.propertiesPatch);
  assertWritableProperties(properties, patchKeys, options);

  const database = await databasesStore.getDatabase(client, input.databaseId);
  if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  let propertiesPatch = input.propertiesPatch;
  // Same ownership-keyed derivation as createItemWithClient above — see
  // docs/adr/2026-09-19-derived-system-properties-computed-inline-at-choke-point.md.
  if (
    database.ownerModuleId === TASKS_MODULE_ID &&
    (Object.hasOwn(input.propertiesPatch, "timeFrom") || Object.hasOwn(input.propertiesPatch, "timeTo"))
  ) {
    const current = await itemsStore.lockItemById(client, input.databaseId, input.itemId);
    if (!current || current.deletedAt) throw new NotFoundError(`Item ${input.itemId} not found`);
    const effectiveTimeFrom = Object.hasOwn(input.propertiesPatch, "timeFrom")
      ? input.propertiesPatch.timeFrom
      : current.properties.timeFrom;
    const effectiveTimeTo = Object.hasOwn(input.propertiesPatch, "timeTo")
      ? input.propertiesPatch.timeTo
      : current.properties.timeTo;
    propertiesPatch = {
      ...input.propertiesPatch,
      time: deriveTaskTime(
        typeof effectiveTimeFrom === "string" ? effectiveTimeFrom : null,
        typeof effectiveTimeTo === "string" ? effectiveTimeTo : null,
      ),
    };
  }

  const item = await itemsStore.updateItemProperties(client, {
    databaseId: input.databaseId,
    itemId: input.itemId,
    propertiesPatch,
    ifVersion: input.ifVersion,
  });
  // The generic item mutation is the sole origin for user/agent triage intent. Persist it
  // in the same transaction as the Email patch so a crash cannot leave UI state committed
  // without a restart-safe provider write to perform.
  if (database.ownerModuleId === EMAILS_MODULE_ID) {
    await recordDesiredMailMessageFlags(client, item.id, propertiesPatch);
  }
  await triggerOnItemEventHeartbeats(client, input.databaseId, "update", item.id, options.queueAffinity);

  for (const key of patchKeys) {
    const dependencies = await findDependenciesBySource(client, input.databaseId, key);
    for (const dependency of dependencies) {
      const edges = await relationsStore.listRelationsForItem(client, dependency.relationDefinitionId, item.id);
      for (const edge of edges) {
        await enqueueRollupRecompute(client, dependency.rollupPropertyId, relationsStore.otherSide(edge, item.id));
      }
    }
  }

  const settingsItemId = await getSystemSettingsItemId(client).catch((err) => {
    if (err instanceof NotFoundError) return null; // system not seeded yet
    throw err;
  });
  if (settingsItemId === item.id && typeof input.propertiesPatch.timezone === "string") {
    const timezone = input.propertiesPatch.timezone;
    // Validated before it reaches computeNextFireAt, where an invalid zone would surface
    // much later as a Postgres "Invalid time value" from serializing next_fire_at = NaN.
    assertValidTimezone(timezone);
    await recomputeAllForTimezoneChange(client, timezone);
  }

  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: item.databaseId,
      itemId: item.id,
      op: "update",
      updatedAt: item.updatedAt,
      userId: options.actingUserId,
    }),
  );
  return item;
}

export function createItemWriteOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    async createItem(input: CreateItemInput, actingUserId?: string): Promise<ItemRow> {
      return withTransaction(pool, (client) => createItemWithClient(client, input, { queueAffinity, actingUserId }));
    },

    async updateItem(input: UpdateItemInput, actingUserId?: string): Promise<ItemRow> {
      return withTransaction(pool, (client) => updateItemWithClient(client, input, { queueAffinity, actingUserId }));
    },
  };
}
