import { BlockInputError, parseMarkdown } from "@semprec/block-model";
import { ConflictError } from "../errors.js";
import { projectItemsForRead } from "./itemReadProjection.js";
import { attachItemPatchChangeMetadata } from "./itemPatchChangeMetadata.js";
import { z } from "zod";
// Owns the choke point's item writes: `createItem` / `updateItem` and their transaction-scoped
// `createItemWithClient` / `updateItemWithClient` counterparts, the property writability checks
// they share, the archived-database create guard with its idempotent-replay exception, the
// owning module's pre-write transforms (the ownership check on the keys they add), and
// `writeComputedAndAnnounce`. A domain's own derived property (e.g. Tasks' `time`) is a pre-write
// transform registered by that domain, and a domain's own transactional side effect on an item
// update (e.g. the Emails flag-sync write, the Tasks recurrence advance on a `status: 'done'`
// write) runs through `runItemUpdateHooks` (./hooks.ts), never a direct import
// of the domain, with `convergeObservedEmailFlagsWithClient` below as mail sync's own declared,
// narrow ownership handoff for Emails' owner:'user' `read`/`flagged` properties — see its doc
// comment. It does not own item reads
// (itemReads.ts), trash and restore (itemTrash.ts), or relation writes (relationOps.ts).
// Constrained by:
// - docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md
// - docs/adr/2026-09-28-module-transactional-side-effects-inline-at-choke-point.md
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-10-choke-point-api-for-state-writes.md
// - docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
// - docs/adr/2026-09-10-single-writer-ownership-model.md
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
  prepareItemPreWriteTransforms,
  runItemCreateHooks,
  runItemPreWriteTransforms,
  runItemUpdateHooks,
  type ItemPreWriteTransformContext,
} from "./hooks.js";
import { SYSTEM_WRITER, type WriterIdentity } from "./writerKind.js";
import { assertValueLinkHandoff, breakValueLinks, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";
import { isDeepStrictEqual } from "node:util";

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

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * Value check for `color` properties: `null` clears the color, anything else must be `#RRGGBB`.
 * Inspects only the keys present in the write, so rows already stored in another format stay
 * untouched until that key is written again. Runs unconditionally, independent of the
 * `allowedSystemKeys` escape hatch.
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
    if (byKey.get(key)?.config.format !== "markdown" || value === null) continue;
    if (typeof value !== "string") throw new ValidationError("Markdown value must be a string", { field: key });
    try {
      parseMarkdown(value, { allowPage: false });
    } catch (error) {
      if (error instanceof BlockInputError) throw new ValidationError("Invalid Markdown value", { field: key });
      throw error;
    }
  }
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
        // Same code as the relation-write refusal in relationEdgeContext.ts, so both refusals of a
        // system-owned field share one code (issue #1454).
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
 * A user or agent write must leave the database's user-owned title property non-blank. Internal
 * writers keep their behavior (several create items whose title is written later or derived) and
 * Transcripts is exempt, since a transcript is named from its event or recording date. Stored
 * titles are not trimmed; only a value that is blank after trimming is rejected. On create the
 * title must be present; on patch only a title key that the patch mentions is checked.
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

/** Checks a proposed user patch using the side-effect-free checks of an item update. */
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
 * Prepares a user patch without a database client or write hooks. `timezone` is the tenant zone the
 * caller read and validated in its own tenant transaction (`getSystemTimezone` + `assertValidTimezone`);
 * preparations that depend on the wall clock, such as the Events time rules, use it as a plain value.
 */
export async function prepareUserItemPatch(
  properties: PropertyRow[],
  values: Record<string, unknown>,
  database: DatabaseRow,
  stored: ItemRow,
  timezone: string,
): Promise<{ patch: Record<string, unknown>; deferredKeys: string[] }> {
  const callerKeys = Object.keys(values);
  assertUserItemPatchValid(properties, values, database.ownerModuleId);
  if (database.ownerModuleId === null) return { patch: values, deferredKeys: [] };
  const result = await prepareItemPreWriteTransforms(database.ownerModuleId, {
    stored,
    patch: { ...values },
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
  return result;
}

/**
 * The ownership rule for keys a pre-write transform adds (the caller's own keys were already checked by
 * `assertWritableProperties`): the key must exist on the database, must be writable through the generic
 * path (not a rollup or relation), and when it is `owner: 'system'` its `ownerProcess` must be unset or
 * name the transform's own module. Only keys absent from the caller's patch are inspected.
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

/**
 * Runs the owning module's pre-write transforms over one write's properties, then enforces the ownership
 * rule on the keys they added. The caller checks `hasItemPreWriteTransform` first, so a database whose
 * module registered none never reaches this function.
 */
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

/**
 * Item creation's own archived-database guard: unlike every other mutation, a create must let
 * through the one no-write exception the issue carves out — a replay of an idempotency key
 * that already committed a row before the database was archived returns that existing row
 * instead of failing, so a retried request doesn't turn a transient error into a permanent
 * failure. A new key, or a key reserved for this database whose item is missing or trashed
 * (see `findIdempotentReplay`'s `deletedAt` filter), still gets `database_archived` — only
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
  /** Queue affinity to route the onItemEvent heartbeat-fire job to, looked up by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
  /** The user whose write this is, when there is one — see `InvalidationEvent`'s doc comment. Absent for a system/background caller. */
  actingUserId?: string;
  /** Set only for a human REST writer (`restSession` actor); read by domain hooks that confine a write to humans. */
  humanWriterUserId?: string;
  /** Who made the write; defaults to `SYSTEM_WRITER`. Derived server-side by the caller, never from a request body. */
  writer?: WriterIdentity;
}

export interface CreateItemInput {
  databaseId: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * The item-creation logic, factored out (same reason as `createRelationPropertyWithClient`
 * above) so a caller already holding an open transaction can run it against that same
 * `client` — namely `tasks/advanceTaskRecurrenceWithClient.ts`, whose rolling-model advance must create
 * the next task instance and re-link its relations in the same transaction as the `done` write,
 * and `journal/journalStore.ts`, whose lazy item creation writes
 * owner:'system' properties (`allowedSystemKeys`) as Journal's declared owning process for
 * exactly those keys. `createChokePoint(...)`'s `createItem` below is a thin wrapper over this.
 * An idempotency-key replay (`insertItemWithReplay`'s `created: false`) returns the
 * already-committed item as-is: no heartbeat trigger, no invalidation, since both already
 * fired for the call that actually created it.
 */
export async function createItemWithClient(
  client: PoolClient,
  input: CreateItemInput,
  options: CreateItemWithClientOptions = {},
): Promise<ItemRow> {
  return (await createItemReportingReplay(client, input, options)).item;
}

export async function createItemReportingReplay(
  client: PoolClient,
  input: CreateItemInput,
  options: CreateItemWithClientOptions,
): Promise<{ item: ItemRow; created: boolean }> {
  const replay = await assertDatabaseWritableForCreate(client, input.databaseId, input.idempotencyKey);
  if (replay) return { item: replay, created: false };

  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  assertWritableProperties(properties, Object.keys(input.properties ?? {}), options);
  assertColorValues(properties, input.properties ?? {});
  assertMarkdownValues(properties, input.properties ?? {});

  const database = await databasesStore.getDatabase(client, input.databaseId);
  if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  const writer = options.writer ?? SYSTEM_WRITER;
  let itemProperties = input.properties ?? {};
  const moduleId = database.ownerModuleId;
  const { item, created } = await itemsStore.insertItemWithReplay(
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
        // A key already set by the caller or by a transform keeps its value; only an absent key takes its default.
        if (Object.hasOwn(itemProperties, property.key) || !Object.hasOwn(property.config, "default")) continue;
        const value = property.config.default;
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
      return itemProperties;
    },
  );
  if (!created) return { item, created: false };

  // Domain validation/side effects of a real insert run here, in the same transaction, so a
  // rejection rolls the row back — see docs/adr/2026-10-09-item-create-domain-hooks.md.
  await runItemCreateHooks({
    client,
    database,
    item,
    properties: itemProperties,
    humanWriterUserId: options.humanWriterUserId,
    writer,
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
  return { item, created: true };
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
  /** Set only for a human REST writer (`restSession` actor); read by domain hooks that confine a write to humans. */
  humanWriterUserId?: string;
  /** Who made the write; defaults to `SYSTEM_WRITER`. Derived server-side by the caller, never from a request body. */
  writer?: WriterIdentity;
  /**
   * Set only by `convergeObservedEmailFlagsWithClient` below, mail sync's declared, narrow
   * ownership handoff for Emails' owner:'user' `read`/`flagged` properties — never by a
   * user-initiated write. Skips `recordDesiredMailMessageFlags`: that call exists to persist
   * *user/agent triage intent* (its own comment below), and a provider observation is not
   * that — `mailFlagObservation.ts`'s `recordObservedMailMessageFlags` already derives
   * `mail_message_flag_sync_state`'s desired/current state correctly for an observation.
   */
  skipMailDesiredStateRecording?: boolean;
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
): Promise<itemsStore.UpdateItemResult> {
  await assertDatabaseNotArchived(client, input.databaseId);
  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  const patchKeys = Object.keys(input.propertiesPatch);
  const database = await databasesStore.getDatabase(client, input.databaseId);
  if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  const command = database.ownerModuleId ? getItemUpdateCommand(database.ownerModuleId) : undefined;
  const commandProperty = command && properties.find((property) => property.key === command.key);
  const hasCommand = !!command && Object.hasOwn(input.propertiesPatch, command.key) && !options.allowedSystemKeys?.includes(command.key);
  if (hasCommand && (!commandProperty || commandProperty.owner !== "system" || commandProperty.ownerProcess !== database.ownerModuleId)) {
    throw new ForbiddenError("Item command owner does not match", { field: command?.key }, "owner_violation");
  }
  assertWritableProperties(properties, patchKeys, hasCommand && command ? { ...options, allowedSystemKeys: [...(options.allowedSystemKeys ?? []), command.key] } : options);
  assertColorValues(properties, input.propertiesPatch);
  assertMarkdownValues(properties, input.propertiesPatch);
  const writer = options.writer ?? SYSTEM_WRITER;
  assertTitlePresent(properties, input.propertiesPatch, database.ownerModuleId, writer, "patch");
  let propertiesPatch = input.propertiesPatch;
  const moduleId = database.ownerModuleId;
  const valueLinksHandoff = options.systemOwnerProcess === VALUE_LINKS_OWNER_PROCESS;
  const needsTransform = moduleId !== null && hasItemPreWriteTransform(moduleId);
  let stored: Awaited<ReturnType<typeof itemsStore.lockItemById>> = null;
  if (valueLinksHandoff || needsTransform || hasCommand) {
    stored = await itemsStore.lockItemById(client, input.databaseId, input.itemId);
    if (!stored || stored.deletedAt) throw new NotFoundError(`Item ${input.itemId} not found`);
  }
  if (stored && input.ifVersion !== undefined && input.ifVersion !== stored.updatedAt) {
    throw new ConflictError("Item was modified since ifVersion was read", { current: stored });
  }
  const ordinaryPatch = { ...input.propertiesPatch };
  if (hasCommand && command) delete ordinaryPatch[command.key];
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
  if (hasCommand && command && moduleId && stored) {
    command.prepare(input.propertiesPatch[command.key]);
    const generated = await command.consume({ client, database, stored, patch: propertiesPatch, writer, humanWriterUserId: options.humanWriterUserId }, input.propertiesPatch[command.key]);
    assertTransformAddedKeysWritable(properties, Object.keys(ordinaryPatch), generated, moduleId);
    propertiesPatch = { ...propertiesPatch, ...generated };
    if (Object.keys(propertiesPatch).length === 0) return { ...stored, previous: { [command.key]: stored.properties[command.key] ?? null } };
  }
  // Every key this update writes, including any a transform added. Value links, rollup dependencies
  // and the timezone check treat these like any other written key; `patchKeys` (the caller's keys)
  // stays the basis of the returned `previous`.
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

  const { previous, ...item } = await itemsStore.updateItemProperties(client, {
    databaseId: input.databaseId,
    itemId: input.itemId,
    propertiesPatch,
    ifVersion: input.ifVersion,
  });
  // A user or agent write that changes a linked value ends its link, in this transaction.
  await breakValueLinks(client, {
    itemId: item.id,
    propertyKeys: writtenKeys.filter((key) => !isDeepStrictEqual(previous[key], propertiesPatch[key])),
    writerKind: writer.writerKind,
  });
  // Every domain's transactional side effect on this write (the Tasks recurrence advance on a
  // `status: 'done'` write, the Emails flag-sync write, ...) runs here, in the same transaction,
  // through the per-process registry — see docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md.
  // `skipMailDesiredStateRecording` opts a provider-observation convergence out of the Emails
  // flag-sync write — see `UpdateItemWithClientOptions`'s doc comment.
  await runItemUpdateHooks({
    client,
    database,
    item,
    propertiesPatch,
    humanWriterUserId: options.humanWriterUserId,
    writer,
    skipMailDesiredStateRecording: options.skipMailDesiredStateRecording,
  });
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
 * The explicit ownership handoff docs/adr/2026-09-10-single-writer-ownership-model.md's
 * "Consequences" section calls for when a feature needs a second writer: mail sync
 * (mail/mailFlagObservation.ts) is the sole declared writer of Emails' owner:'user'
 * `read`/`flagged` properties for exactly one case — folding a *converged* provider
 * observation (no pending user write-back to protect) into the item, so the mailbox doesn't
 * keep showing state the provider itself has already moved past. Distinct from a plain call to
 * `updateItemWithClient` (which a user-initiated PATCH also uses, indistinguishably, since
 * `assertWritableProperties` never restricts owner:'user' fields) so this one narrow,
 * code-reviewed call site is the only thing that can pass `skipMailDesiredStateRecording` —
 * see that option's doc comment for why an observation must skip it. Never call
 * `updateItemWithClient` directly with that option from anywhere else, and never use this
 * function for any field but Emails' `read`/`flagged`.
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

/** Nightly Tasks ownership handover; see the rollover and missed-occurrence ADRs. */
export async function rolloverTaskWithClient(client: PoolClient, input: RolloverTaskInput): Promise<ItemRow> {
  const propertiesPatch = input.status === "missed"
    ? { status: "missed" }
    : { date: input.date, timeFrom: null, timeTo: null };
  return updateItemWithClient(client, { databaseId: input.databaseId, itemId: input.itemId, propertiesPatch });
}

/**
 * The items-row `FOR UPDATE` lock `mail/mailFlagObservation.ts`'s `applyObservedMailMessageFlags`
 * takes before it locks `mail_message_flag_sync_state`, in that order — see that function's doc
 * comment for why the ordering matters. Exposed here, next to `convergeObservedEmailFlagsWithClient`
 * (mail sync's other declared handoff into the choke point), so mail sync locks the items row
 * through chokePoint's own public write surface instead of importing `itemsStore.js` — an internal
 * module only chokePoint/ files import from — directly.
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
        return (await projectItemsForRead(client, [item]))[0]!;
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
          return (await projectItemsForRead(client, [item]))[0]!;
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
                })
                .passthrough(),
            })
            .passthrough()
            .safeParse(error.details);
          if (!details.success) throw error;
          const current = (await projectItemsForRead(client, [details.data.current]))[0]!;
          throw new ConflictError(error.message, { ...details.data, current });
        }
      });
    },
  };
}
