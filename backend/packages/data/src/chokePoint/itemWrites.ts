import { BlockInputError, parseMarkdown } from "@semprec/block-model";
import { ConflictError } from "../errors.js";
import { projectItemsForRead } from "./itemReadProjection.js";
import { attachItemPatchChangeMetadata } from "./itemPatchChangeMetadata.js";
import { z } from "zod";
// The choke point's item writes: `createItem`/`updateItem` and their `*WithClient` counterparts, the
// shared property writability checks, the archived-database create guard with its idempotent-replay
// exception, the owning module's pre-write transforms, and `writeComputedAndAnnounce`. Domain side
// effects run through the hooks in ./hooks.ts, never a direct domain import;
// `convergeObservedEmailFlagsWithClient` is mail sync's declared ownership handoff for Emails'
// `read`/`flagged`.
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { DatabaseRow, ItemRow, PropertyRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import { findDependenciesBySource } from "../rollup/dependencies.js";
import { enqueueRollupRecompute } from "../rollup/recompute.js";
import { triggerOnItemEventHeartbeats, recomputeAllForTimezoneChange } from "../scheduler/schedulerStore.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertDatabaseNotArchived } from "./databaseGuards.js";
import { assertValidTimezone } from "../timezone.js";
import { getSystemTimezone, getSystemSettingsItemId } from "../systemSettings.js";
import {
  hasItemPreWriteTransform,
  getItemUpdateCommand,
  isItemUpdateCommandPaired,
  prepareItemPreWriteTransforms,
  runItemCreateHooks,
  runItemPreWriteTransforms,
  runItemUpdateHooks,
  runItemUpdatePreLockHooks,
  type ItemCreateInitialRelation,
  type ItemPreWriteTransformContext,
} from "./hooks.js";
import { SYSTEM_WRITER, type WriterIdentity } from "./writerKind.js";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { hideClosedRollupValuesForWriter } from "../agentGrants/closedSensitiveAggregationAccess.js";
import { requireApprovalForChangedItemLinks } from "./valueLinkApproval.js";
import { assertValueLinkHandoff, breakValueLinks, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";
import { isDeepStrictEqual } from "node:util";

interface AssertWritablePropertiesOptions {
  /**
   * Relaxes the owner:'system' rejection for exactly these keys, for a code-defined system writer that
   * is their declared owning process (e.g. Journal's lazy creation of `name`/`type`/`period`). Per key,
   * so it cannot write another system-owned field. Never set from a request-handling path.
   */
  allowedSystemKeys?: readonly string[];
  /** Must match each system field's `ownerProcess`. */
  systemOwnerProcess?: string;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * `null` clears the color, anything else must be `#RRGGBB`. Only keys in the write are checked, so
 * values stored in another format stay until rewritten. Not relaxed by `allowedSystemKeys`.
 */
function assertColorValues(properties: PropertyRow[], values: Record<string, unknown>): void {
  const byKey = new Map(properties.map((p) => [p.key, p]));
  for (const [key, value] of Object.entries(values)) {
    if (byKey.get(key)?.type !== "color" || value === null) continue;
    if (typeof value !== "string" || !HEX_COLOR.test(value)) {
      throw new ValidationError(`Property '${key}' must be a color in #RRGGBB format or null`, { field: key });
    }
  }
}

function assertMarkdownValues(properties: PropertyRow[], values: Record<string, unknown>): void {
  const byKey = new Map(properties.map((property) => [property.key, property]));
  for (const [key, value] of Object.entries(values)) {
    const property = byKey.get(key);
    if (!property) continue;
    const config: unknown = property.config;
    if (typeof config !== "object" || config === null || Array.isArray(config))
      throw new Error("Malformed property config");
    if (!("format" in config) || config.format !== "markdown" || value === null) continue;
    if (typeof value !== "string") throw new ValidationError("Markdown value must be a string", { field: key });
    try {
      parseMarkdown(value, { allowPage: false });
    } catch (error) {
      if (error instanceof BlockInputError) throw new ValidationError("Invalid Markdown value", { field: key });
      throw error;
    }
  }
}

/** Relation values live only in item_relations, and computed is internal-only. */
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
      // Rollup values live in items.computed, written only by the recompute worker.
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
        // Same code as the relation-write refusal in relationEdgeContext.ts.
        throw new ForbiddenError(
          `Property '${key}' is owned by 'system' and cannot be written by this caller`,
          { field: key },
          "owner_violation",
        );
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
 * A user or agent write into a system database with no user-owned property is refused whole: an
 * empty create or patch names no key for `assertWritableProperties` to refuse and would otherwise
 * touch a row only the owning process may write. Trusted owners (`allowedSystemKeys`), the system
 * writer and user-created databases are unaffected.
 */
function assertCallerMayWriteDatabase(
  database: DatabaseRow,
  properties: PropertyRow[],
  writer: WriterIdentity,
  options: AssertWritablePropertiesOptions,
): void {
  if (writer.writerKind === "system" || !database.system) return;
  if (options.allowedSystemKeys !== undefined && options.allowedSystemKeys.length > 0) return;
  if (properties.some((property) => property.owner === "user")) return;
  throw new ForbiddenError(
    `Database ${database.id} has no property this caller may write`,
    { field: "databaseId" },
    "owner_violation",
  );
}

/**
 * A user or agent write must leave the user-owned title non-blank (after trimming; stored titles are
 * not trimmed). Internal writers and Transcripts (named from its date) are exempt. On create the
 * title must be present; on patch only a mentioned title key is checked.
 */
function assertTitlePresent(
  properties: PropertyRow[],
  values: Record<string, unknown>,
  ownerModuleId: string | null,
  writer: WriterIdentity,
  mode: "create" | "patch",
): void {
  if (writer.writerKind === "system" || ownerModuleId === TRANSCRIPTS_MODULE_ID) return;
  const title = properties.find((p) => p.type === "title" && p.owner === "user");
  if (!title) return;
  if (mode === "patch" && !Object.hasOwn(values, title.key)) return;
  const value = values[title.key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`Property '${title.key}' must be a non-empty title`, { field: title.key });
  }
}

const selectOptionsConfigSchema = z.object({ options: z.array(z.object({ key: z.string() })).optional() });

/**
 * A user or agent write may name only catalog options: a `select` value is `null` or an option key, a
 * `multi_select` value is `null` or an array of them (`[]` clears). Internal ingest writers are not
 * checked. Only `patch` keys are inspected; a value deep-equal to the one in `stored` passes, so a
 * client sending a whole record back does not fail on a retired option (`stored` is `null` when
 * nothing is stored). A violation is a `ValidationError` on the property key. The caller never passes
 * values filled from `config.default`.
 */
export function assertSelectValuesKnown(
  properties: PropertyRow[],
  patch: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  writer: WriterIdentity,
): void {
  if (writer.writerKind === "system") return;
  const byKey = new Map(properties.map((p) => [p.key, p]));
  for (const [key, value] of Object.entries(patch)) {
    const property = byKey.get(key);
    if (!property || (property.type !== "select" && property.type !== "multi_select") || value === null) continue;
    if (stored !== null && isDeepStrictEqual(stored[key], value)) continue;
    const config = selectOptionsConfigSchema.safeParse(property.config);
    if (!config.success) throw new Error("Malformed property config");
    const known = new Set((config.data.options ?? []).map((option) => option.key));
    const many = property.type === "multi_select";
    if (many && !Array.isArray(value)) {
      throw new ValidationError(`Property '${key}' must be an array of option keys or null`, { field: key });
    }
    const candidates: unknown[] = many && Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        throw new ValidationError(
          `Property '${key}' must be ${many ? "an array of option keys" : "an option key"} or null`,
          { field: key },
        );
      }
      if (!known.has(candidate)) {
        throw new ValidationError(`Property '${key}' has the unknown option '${candidate}'`, { field: key });
      }
    }
  }
}

/** The side-effect-free checks of an item update, for a proposed user patch. */
export function assertUserItemPatchValid(
  properties: PropertyRow[],
  values: Record<string, unknown>,
  ownerModuleId: string | null,
): void {
  assertWritableProperties(properties, Object.keys(values));
  assertColorValues(properties, values);
  assertMarkdownValues(properties, values);
  assertTitlePresent(properties, values, ownerModuleId, { writerKind: "user" }, "patch");
}

/**
 * Prepares a user patch without a client or write hooks. `timezone` is the tenant zone the caller
 * validated in its own tenant transaction; wall-clock preparations (e.g. Events time rules) use it.
 */
export async function prepareUserItemPatch(
  properties: PropertyRow[],
  values: Record<string, unknown>,
  database: DatabaseRow,
  stored: ItemRow,
  timezone: string,
): Promise<{
  patch: Record<string, unknown>;
  deferredKeys: string[];
  command?: { key: string; intent: unknown; preconditions: Record<string, unknown> };
}> {
  const callerKeys = Object.keys(values);
  const command = database.ownerModuleId ? getItemUpdateCommand(database.ownerModuleId) : undefined;
  const hasCommand = command !== undefined && Object.hasOwn(values, command.key);
  const ordinary = { ...values };
  let preparedCommand: { key: string; intent: unknown; preconditions: Record<string, unknown> } | undefined;
  if (hasCommand && command) {
    const property = properties.find((candidate) => candidate.key === command.key);
    if (!database.ownerModuleId || !isItemUpdateCommandPaired(database.ownerModuleId, command))
      throw new ValidationError("The item command has no owning transform", { field: command.key });
    if (!property || property.owner !== "system" || property.ownerProcess !== database.ownerModuleId)
      throw new ForbiddenError("Item command owner does not match", { field: command.key }, "owner_violation");
    assertWritableProperties(properties, [command.key], { allowedSystemKeys: [command.key] });
    delete ordinary[command.key];
    const prepared = command.prepare(values[command.key], stored, ordinary);
    preparedCommand = { key: command.key, ...prepared };
  }
  assertUserItemPatchValid(properties, ordinary, database.ownerModuleId);
  if (database.ownerModuleId === null) return { patch: values, deferredKeys: [] };
  const result = await prepareItemPreWriteTransforms(database.ownerModuleId, {
    stored,
    patch: ordinary,
    timezone,
  });
  if (!result)
    throw new ValidationError("The item's write transform cannot be safely prepared", { field: "properties" });
  assertTransformAddedKeysWritable(properties, callerKeys, result.patch, database.ownerModuleId);
  assertColorValues(properties, result.patch);
  assertMarkdownValues(properties, result.patch);
  assertTitlePresent(properties, result.patch, database.ownerModuleId, { writerKind: "user" }, "patch");
  for (const key of result.deferredKeys) {
    const property = properties.find((candidate) => candidate.key === key);
    if (!property || property.owner !== "user" || callerKeys.includes(key) || Object.hasOwn(result.patch, key)) {
      throw new ValidationError("The item's write transform declared an invalid deferred key", { field: key });
    }
  }
  return preparedCommand ? { ...result, command: preparedCommand } : result;
}

/**
 * Keys a transform adds (the caller's were checked by `assertWritableProperties`) must exist, be
 * writable through the generic path, and if `owner: 'system'` have an unset `ownerProcess` or name the
 * transform's own module.
 */
function assertTransformAddedKeysWritable(
  properties: PropertyRow[],
  callerKeys: readonly string[],
  transformed: Record<string, unknown>,
  moduleId: string,
): void {
  const byKey = new Map(properties.map((p) => [p.key, p]));
  for (const key of Object.keys(transformed)) {
    if (callerKeys.includes(key)) continue;
    const property = byKey.get(key);
    if (!property) {
      throw new ValidationError(`Unknown property key '${key}'`, { field: key });
    }
    if (property.type === "rollup") {
      throw new ForbiddenError(
        `Property '${key}' is a rollup; its value lives in computed and is read-only here`,
        { field: key },
        "computed_readonly",
      );
    }
    if (property.type === "relation") {
      throw new ValidationError(
        `Property '${key}' is a relation; write it via createRelation/deleteRelation, not item properties`,
        { field: key },
      );
    }
    if (property.owner === "system" && property.ownerProcess !== null && property.ownerProcess !== moduleId) {
      throw new ForbiddenError(
        `Property '${key}' is owned by process '${property.ownerProcess}' and cannot be written by module '${moduleId}'`,
        { field: key },
        "owner_violation",
      );
    }
  }
}

/** The caller checks `hasItemPreWriteTransform` first. */
async function applyItemPreWriteTransforms(
  moduleId: string,
  context: ItemPreWriteTransformContext,
  properties: PropertyRow[],
): Promise<Record<string, unknown>> {
  const callerKeys = Object.keys(context.patch);
  const transformed = await runItemPreWriteTransforms(moduleId, { ...context, patch: { ...context.patch } });
  assertTransformAddedKeysWritable(properties, callerKeys, transformed, moduleId);
  return transformed;
}

/** Re-reads a row this transaction wrote and still holds locked. */
async function requireStoredItem(client: PoolClient, item: ItemRow): Promise<ItemRow> {
  const stored = await itemsStore.getItemById(client, item.databaseId, item.id);
  if (!stored) throw new NotFoundError(`Item ${item.id} not found`);
  return stored;
}

/**
 * A create on an archived database is let through only as an exact replay of an idempotency key that
 * committed a row before archiving, so a retry does not turn a transient error permanent. Any other
 * key (including one whose item is missing or trashed) gets `database_archived`. Returns the replay
 * row to return verbatim, or `null` when the database is not archived.
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
    const replay = await itemsStore.findIdempotentReplay(client, databaseId, idempotencyKey, { requireLive: true });
    if (replay) return replay;
  }
  throw new ForbiddenError(
    `Database ${databaseId} is archived and cannot be written to`,
    { field: "databaseId" },
    "database_archived",
  );
}

export interface CreateItemWithClientOptions extends AssertWritablePropertiesOptions {
  /** Routes the onItemEvent heartbeat-fire job, by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
  /** Absent for a system/background caller; see `InvalidationEvent`. */
  actingUserId?: string;
  /** Set only for a human REST writer; read by hooks that confine a write to humans. */
  humanWriterUserId?: string;
  /** Defaults to `SYSTEM_WRITER`. Derived server-side, never from a request body. */
  writer?: WriterIdentity;
}

export interface CreateItemInput {
  databaseId: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * For callers already in a transaction (e.g. the Tasks recurrence advance, Journal's lazy creation
 * with `allowedSystemKeys`). An idempotency-key replay returns the committed item as-is, with no
 * heartbeat or invalidation, since both fired for the original create.
 */
export async function createItemWithClient(
  client: PoolClient,
  input: CreateItemInput,
  options: CreateItemWithClientOptions = {},
): Promise<ItemRow> {
  return (await createItemReportingReplay(client, input, options)).item;
}

/**
 * Also reports whether this call inserted the item. `initialRelations` reach the create hooks as
 * `ItemCreateHookContext.initialRelations`.
 */
export async function createItemReportingReplay(
  client: PoolClient,
  input: CreateItemInput,
  options: CreateItemWithClientOptions,
  initialRelations?: readonly ItemCreateInitialRelation[],
): Promise<{ item: ItemRow; created: boolean }> {
  // Also required for an idempotent replay.
  await assertWriterDatabaseAccess(client, options.writer, input.databaseId, "write");
  const replay = await assertDatabaseWritableForCreate(client, input.databaseId, input.idempotencyKey);
  if (replay) return { item: replay, created: false };

  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  const database = await databasesStore.getDatabase(client, input.databaseId);
  if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  const writer = options.writer ?? SYSTEM_WRITER;
  assertWritableProperties(properties, Object.keys(input.properties ?? {}), options);
  assertCallerMayWriteDatabase(database, properties, writer, options);
  assertColorValues(properties, input.properties ?? {});
  assertMarkdownValues(properties, input.properties ?? {});

  let itemProperties = input.properties ?? {};
  const defaultedKeys = new Set<string>();
  const moduleId = database.ownerModuleId;
  const { item: inserted, created } = await itemsStore.insertItemWithReplay(
    client,
    { databaseId: input.databaseId, properties: itemProperties, idempotencyKey: input.idempotencyKey },
    async () => {
      if (moduleId !== null && hasItemPreWriteTransform(moduleId)) {
        itemProperties = await applyItemPreWriteTransforms(
          moduleId,
          {
            client,
            database,
            stored: null,
            patch: itemProperties,
            humanWriterUserId: options.humanWriterUserId,
            writer,
          },
          properties,
        );
      }
      itemProperties = { ...itemProperties };
      let today: string | undefined;
      for (const property of properties) {
        // Only a key absent after the caller and transforms takes its default.
        if (Object.hasOwn(itemProperties, property.key) || !Object.hasOwn(property.config, "default")) continue;
        const value = property.config.default;
        defaultedKeys.add(property.key);
        if (property.type === "date" && value === "today") {
          if (today === undefined) {
            const timezone = await getSystemTimezone(client);
            assertValidTimezone(timezone);
            today = DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");
          }
          itemProperties[property.key] = today;
        } else {
          itemProperties[property.key] = value;
        }
      }
      assertColorValues(properties, itemProperties);
      assertMarkdownValues(properties, itemProperties);
      assertTitlePresent(properties, itemProperties, database.ownerModuleId, writer, "create");
      // A defaulted value is not a caller value: its option key was checked when the default was written,
      // and a multi_select default is stored as a bare key.
      assertSelectValuesKnown(
        properties,
        Object.fromEntries(Object.entries(itemProperties).filter(([key]) => !defaultedKeys.has(key))),
        null,
        writer,
      );
      return itemProperties;
    },
  );
  if (!created) return { item: inserted, created: false };

  // In the same transaction, so a rejection rolls the row back.
  await runItemCreateHooks({
    client,
    database,
    item: inserted,
    properties: itemProperties,
    defaultedKeys,
    humanWriterUserId: options.humanWriterUserId,
    writer,
    initialRelations,
  });
  // A create hook may write the new item again (Areas assigns its `position`): answer with the row as stored.
  const item =
    itemsStore.itemPropertyWriteCount(client, inserted.databaseId, inserted.id) === 0
      ? inserted
      : await requireStoredItem(client, inserted);
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
  return { item, created: true };
}

/**
 * `itemsStore.writeComputed` for a module cache value the UI shows live: writes in the caller's
 * transaction and announces over realtime after commit, with the `updatedAt` the write read back.
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
  /** Routes the onItemEvent heartbeat-fire job, by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
  /** Absent for a system/background caller; see `InvalidationEvent`. */
  actingUserId?: string;
  /** Set only for a human REST writer; read by hooks that confine a write to humans. */
  humanWriterUserId?: string;
  /** Defaults to `SYSTEM_WRITER`. Derived server-side, never from a request body. */
  writer?: WriterIdentity;
  /**
   * Set only by `convergeObservedEmailFlagsWithClient`. Skips `recordDesiredMailMessageFlags`, which
   * persists user/agent triage intent; a provider observation is not that, and
   * `recordObservedMailMessageFlags` already derives the sync state for it.
   */
  skipMailDesiredStateRecording?: boolean;
}

/**
 * `options.allowedSystemKeys` lets a declared owning process (e.g. library metadata writing `cover`)
 * patch its owner:'system' fields after creation. The public wrapper never passes it.
 */
export async function updateItemWithClient(
  client: PoolClient,
  input: UpdateItemInput,
  options: UpdateItemWithClientOptions = {},
): Promise<itemsStore.UpdateItemResult> {
  await assertWriterDatabaseAccess(client, options.writer, input.databaseId, "write", input.itemId);
  await assertDatabaseNotArchived(client, input.databaseId);
  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  const patchKeys = Object.keys(input.propertiesPatch);
  const database = await databasesStore.getDatabase(client, input.databaseId);
  if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  const command = database.ownerModuleId ? getItemUpdateCommand(database.ownerModuleId) : undefined;
  const commandProperty = command && properties.find((property) => property.key === command.key);
  const hasCommand =
    !!command && Object.hasOwn(input.propertiesPatch, command.key) && !options.allowedSystemKeys?.includes(command.key);
  if (
    hasCommand &&
    (!commandProperty || commandProperty.owner !== "system" || commandProperty.ownerProcess !== database.ownerModuleId)
  ) {
    throw new ForbiddenError("Item command owner does not match", { field: command?.key }, "owner_violation");
  }
  const writeOptions =
    hasCommand && command
      ? { ...options, allowedSystemKeys: [...(options.allowedSystemKeys ?? []), command.key] }
      : options;
  const writer = options.writer ?? SYSTEM_WRITER;
  assertWritableProperties(properties, patchKeys, writeOptions);
  assertCallerMayWriteDatabase(database, properties, writer, writeOptions);
  assertColorValues(properties, input.propertiesPatch);
  assertMarkdownValues(properties, input.propertiesPatch);
  assertTitlePresent(properties, input.propertiesPatch, database.ownerModuleId, writer, "patch");
  let propertiesPatch = input.propertiesPatch;
  const moduleId = database.ownerModuleId;
  // Module locks come before the first lock on the written row (the transform lock below and the row
  // update): docs/architecture/data-model-and-writes.md#update-updateitemwithclient.
  if (moduleId !== null) {
    await runItemUpdatePreLockHooks(moduleId, {
      client,
      database,
      itemId: input.itemId,
      patch: input.propertiesPatch,
    });
  }
  const valueLinksHandoff = options.systemOwnerProcess === VALUE_LINKS_OWNER_PROCESS;
  const needsTransform = moduleId !== null && hasItemPreWriteTransform(moduleId);
  let stored: Awaited<ReturnType<typeof itemsStore.lockItemById>> = null;
  // The select check below accepts a value equal to the stored one, so it reads the locked row.
  const needsSelectCheck =
    writer.writerKind !== "system" &&
    patchKeys.some((key) => {
      const type = properties.find((property) => property.key === key)?.type;
      return type === "select" || type === "multi_select";
    });
  if (valueLinksHandoff || needsTransform || hasCommand || needsSelectCheck) {
    stored = await itemsStore.lockItemById(client, input.databaseId, input.itemId);
    if (!stored || stored.deletedAt) throw new NotFoundError(`Item ${input.itemId} not found`);
  }
  if (stored && input.ifVersion !== undefined && input.ifVersion !== stored.version) {
    throw new ConflictError("Item was modified since ifVersion was read", { current: stored });
  }
  const ordinaryPatch = { ...input.propertiesPatch };
  if (hasCommand && command) {
    delete ordinaryPatch[command.key];
    if (!moduleId || !isItemUpdateCommandPaired(moduleId, command))
      throw new ValidationError("The item command has no owning transform", { field: command.key });
    propertiesPatch = ordinaryPatch;
  }
  if (moduleId !== null && needsTransform && stored) {
    // The transform reads the locked row that this update will replace.
    propertiesPatch = await applyItemPreWriteTransforms(
      moduleId,
      { client, database, stored, patch: ordinaryPatch, humanWriterUserId: options.humanWriterUserId, writer },
      properties,
    );
    assertColorValues(properties, propertiesPatch);
    assertMarkdownValues(properties, propertiesPatch);
    assertTitlePresent(properties, propertiesPatch, database.ownerModuleId, writer, "patch");
  }
  assertSelectValuesKnown(properties, propertiesPatch, stored?.properties ?? null, writer);
  if (hasCommand && command && moduleId && stored) {
    command.validate(input.propertiesPatch[command.key]);
    const generated = await command.consume(
      { client, database, stored, patch: propertiesPatch, writer, humanWriterUserId: options.humanWriterUserId },
      input.propertiesPatch[command.key],
    );
    assertTransformAddedKeysWritable(properties, Object.keys(ordinaryPatch), generated, moduleId);
    propertiesPatch = { ...propertiesPatch, ...generated };
    if (Object.keys(propertiesPatch).length === 0)
      return { ...stored, previous: { [command.key]: stored.properties[command.key] ?? null } };
  }
  // Every key written, transform-added included, counts for value links, rollup dependencies and the
  // timezone check; `patchKeys` (the caller's) stays the basis of `previous`.
  const writtenKeys = Object.keys(propertiesPatch);
  if (valueLinksHandoff) {
    const userKeys = new Set(
      properties.filter((property) => property.owner === "user").map((property) => property.key),
    );
    const handoffKeys = new Set([...patchKeys, ...writtenKeys.filter((key) => userKeys.has(key))]);
    for (const key of [...handoffKeys].sort()) {
      await assertValueLinkHandoff(client, { itemId: input.itemId, propertyKey: key });
    }
  }

  const { previous, ...written } = await itemsStore.updateItemProperties(client, {
    databaseId: input.databaseId,
    itemId: input.itemId,
    propertiesPatch,
    ifVersion: input.ifVersion,
  });
  const ownWriteCount = itemsStore.itemPropertyWriteCount(client, written.databaseId, written.id);
  // A user or agent write that changes a linked value ends its link here. An agent under a run asks
  // for approval first, rolling this transaction back.
  const changedKeys = writtenKeys.filter((key) => !isDeepStrictEqual(previous[key], propertiesPatch[key]));
  await requireApprovalForChangedItemLinks(client, writer, { itemId: written.id, changedKeys });
  await breakValueLinks(client, { itemId: written.id, propertyKeys: changedKeys, writerKind: writer.writerKind });
  // Every domain's transactional side effect on this write runs here, in the same transaction.
  await runItemUpdateHooks({
    client,
    database,
    item: written,
    propertiesPatch,
    previous,
    humanWriterUserId: options.humanWriterUserId,
    writer,
    skipMailDesiredStateRecording: options.skipMailDesiredStateRecording,
  });
  // An update hook may write the same item again: answer with the row as stored, so its `version` is current.
  const item =
    itemsStore.itemPropertyWriteCount(client, written.databaseId, written.id) === ownWriteCount
      ? written
      : await requireStoredItem(client, written);
  await triggerOnItemEventHeartbeats(client, input.databaseId, "update", item.id, options.queueAffinity);

  for (const key of writtenKeys) {
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
  if (settingsItemId === item.id && typeof propertiesPatch.timezone === "string") {
    const timezone = propertiesPatch.timezone;
    // Validated here; an invalid zone would otherwise surface much later as a Postgres "Invalid time
    // value" from next_fire_at = NaN.
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
  const eligibility = new Map(
    patchKeys.map((key) => {
      const property = properties.find((candidate) => candidate.key === key);
      return [key, property !== undefined && property.type !== "longText"] as const;
    }),
  );
  return attachItemPatchChangeMetadata(
    { ...item, previous: Object.fromEntries(patchKeys.map((key) => [key, previous[key]])) },
    eligibility,
  );
}

export interface ConvergeObservedEmailFlagsInput {
  databaseId: string;
  itemId: string;
  propertiesPatch: Record<string, boolean>;
}

/**
 * Mail sync's declared second writer of Emails' owner:'user' `read`/`flagged`: folds a converged
 * provider observation (no pending user write-back) into the item. The only call site allowed to pass
 * `skipMailDesiredStateRecording`; never use it for any other field.
 */
export async function convergeObservedEmailFlagsWithClient(
  client: PoolClient,
  input: ConvergeObservedEmailFlagsInput,
): Promise<ItemRow> {
  return updateItemWithClient(
    client,
    { databaseId: input.databaseId, itemId: input.itemId, propertiesPatch: input.propertiesPatch },
    { skipMailDesiredStateRecording: true },
  );
}

export type RolloverTaskInput =
  | { databaseId: string; itemId: string; date: string; status?: never }
  | { databaseId: string; itemId: string; status: "missed"; date?: never };

/** Nightly Tasks ownership handover. */
export async function rolloverTaskWithClient(client: PoolClient, input: RolloverTaskInput): Promise<ItemRow> {
  const propertiesPatch =
    input.status === "missed" ? { status: "missed" } : { date: input.date, timeFrom: null, timeTo: null };
  return updateItemWithClient(client, { databaseId: input.databaseId, itemId: input.itemId, propertiesPatch });
}

/**
 * The items-row `FOR UPDATE` lock `applyObservedMailMessageFlags` takes before locking
 * `mail_message_flag_sync_state`. Exposed here so mail sync need not import `itemsStore.js`.
 */
export async function lockItemForObservedMailFlags(
  client: PoolClient,
  databaseId: string,
  itemId: string,
): Promise<ItemRow | null> {
  return itemsStore.lockItemById(client, databaseId, itemId);
}

export function createItemWriteOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    async createItem(
      input: CreateItemInput,
      actingUserId?: string,
      humanWriterUserId?: string,
      writer?: WriterIdentity,
    ): Promise<ItemRow> {
      return withTransaction(pool, async (client) => {
        const item = await createItemWithClient(client, input, {
          queueAffinity,
          actingUserId,
          humanWriterUserId,
          writer,
        });
        return (await hideClosedRollupValuesForWriter(client, writer, await projectItemsForRead(client, [item])))[0]!;
      });
    },

    async updateItem(
      input: UpdateItemInput,
      actingUserId?: string,
      humanWriterUserId?: string,
      writer?: WriterIdentity,
    ): Promise<itemsStore.UpdateItemResult> {
      return withTransaction(pool, async (client) => {
        try {
          const item = await updateItemWithClient(client, input, {
            queueAffinity,
            actingUserId,
            humanWriterUserId,
            writer,
          });
          return (await hideClosedRollupValuesForWriter(client, writer, await projectItemsForRead(client, [item])))[0]!;
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          const details = z
            .object({
              current: z
                .object({
                  id: z.string(),
                  databaseId: z.string(),
                  properties: z.record(z.string(), z.unknown()),
                  computed: z.record(z.string(), z.unknown()),
                  createdAt: z.string(),
                  updatedAt: z.string(),
                  deletedAt: z.string().nullable(),
                  version: z.string(),
                })
                .passthrough(),
            })
            .passthrough()
            .safeParse(error.details);
          if (!details.success) throw error;
          const current = (
            await hideClosedRollupValuesForWriter(
              client,
              writer,
              await projectItemsForRead(client, [details.data.current]),
            )
          )[0]!;
          throw new ConflictError(error.message, { ...details.data, current });
        }
      });
    },
  };
}
