import { isDeepStrictEqual } from "node:util";
import { CardinalityViolationError, ForbiddenError } from "../errors.js";
import type { ProposalStep } from "./proposalEnvelope.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { ALLDOTS_READ_ONLY_MODULE_IDS } from "../seed/inboxPipelineKeys.js";
import { effectiveStepRelations, stepError } from "./proposalStepGraph.js";
import type { PoolClient } from "pg";
import type { PropertyRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { ValidationError } from "../errors.js";
import { assertRelationTargetLinkableWithClient } from "../chokePoint/relationOps.js";
import { BlockInputError, parseMarkdown } from "@alldots/block-model";
import { readPageSummary } from "../docs/pageSummary.js";
import { parseJournalPeriodKey } from "../journal/journalPeriods.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { pageContentV2Schema } from "./proposalEnvelope.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { assertSelectValuesKnown } from "../chokePoint/itemWrites.js";

const PAGE_TARGET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireProposalPageTarget(client: PoolClient, target: string): Promise<ItemRow> {
  if (!PAGE_TARGET_UUID.test(target)) {
    throw new ValidationError(`Proposal envelope target '${target}' is not a page id`, { field: "target" });
  }
  const [targetPage] = await getItemsByIds(client, [target]);
  if (!targetPage) {
    throw new ValidationError(`Proposal envelope target '${target}' is not an existing page`, { field: "target" });
  }
  return targetPage;
}

export async function assertValidV2PageContent(
  client: PoolClient,
  targetPage: ItemRow,
  input: Record<string, unknown>,
): Promise<void> {
  const parsed = pageContentV2Schema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid Markdown page proposal", { field: "properties" });
  try {
    parseMarkdown(parsed.data.markdown, { allowPage: false });
  } catch (error) {
    if (error instanceof BlockInputError)
      throw new ValidationError("Invalid Markdown page proposal", { field: "properties" });
    throw error;
  }
  const database = await databasesStore.getDatabase(client, targetPage.databaseId);
  let host = database?.ownerModuleId === "projects";
  if (
    database?.ownerModuleId === "journal" &&
    targetPage.properties.type === "day" &&
    typeof targetPage.properties.period === "string"
  ) {
    try {
      parseJournalPeriodKey("day", targetPage.properties.period);
      host = true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  if (database?.system && database.key === "pages" && database.ownerModuleId === "pages") {
    const properties = await propertiesStore.listPropertiesByDatabase(client, database.id);
    const parent = properties.find((property) => property.key === "parentItemId");
    host =
      parent?.type === "text" &&
      parent.owner === "system" &&
      parent.ownerProcess === "pages" &&
      typeof targetPage.properties.parentItemId === "string" &&
      PAGE_TARGET_UUID.test(targetPage.properties.parentItemId);
  }
  if (!host) throw new ValidationError("Proposal target is not a page host", { field: "target" });
  if (typeof parsed.data.placement === "object") {
    const afterHeading = parsed.data.placement.afterHeading;
    const summary = await readPageSummary(client, targetPage.id, "en");
    if (!summary.headings.some((heading) => heading.id === afterHeading))
      throw new ValidationError("Proposal heading is unavailable", {
        field: "properties",
        reason: "heading_unavailable",
      });
  }
}

/** `relations` keys must be relation properties of the target, with unique, linkable target ids. */
export async function assertValidEnvelopeRelations(
  client: PoolClient,
  targetDatabaseId: string,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  relations: NonNullable<ProposalEnvelope["relations"]>,
  callerItemId?: string,
): Promise<void> {
  for (const [key, targetItemIds] of Object.entries(relations)) {
    const property = propertiesByKey.get(key);
    if (!property || property.type !== "relation") {
      throw new ValidationError(
        `Proposal relations reference '${key}', which is not a relation property of target database ${targetDatabaseId}`,
        { field: key },
      );
    }
    if (new Set(targetItemIds).size !== targetItemIds.length) {
      throw new ValidationError(`Proposal relations for '${key}' list the same target more than once`, { field: key });
    }
    for (const targetItemId of targetItemIds) {
      await assertRelationTargetLinkableWithClient(client, {
        relationPropertyId: property.id,
        targetItemId,
        callerItemId,
      });
    }
  }
}

function assertWritableProposalPropertyKeys(
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  databaseId: string,
): void {
  for (const key of Object.keys(properties)) {
    const property = propertiesByKey.get(key);
    if (!property) {
      throw new ValidationError(
        `Proposal properties reference unknown property '${key}' on target database ${databaseId}`,
        { field: key },
      );
    }
    if (property.type === "relation") {
      throw new ValidationError(`Proposal properties cannot set relation property '${key}' directly`, { field: key });
    }
    if (property.type === "rollup") {
      throw new ValidationError(`Proposal properties cannot set read-only rollup property '${key}'`, { field: key });
    }
    if (property.owner === "system") {
      throw new ValidationError(`Proposal properties cannot set system-owned property '${key}'`, { field: key });
    }
  }
}

/**
 * Every `select`/`multi_select` value must name a catalog option, as for a user item write (confirm writes as the
 * user). `stored` is the updated item's properties, so a value it already holds is accepted; `null` for creates.
 */
function assertProposalSelectValuesKnown(
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  stored: Record<string, unknown> | null,
): void {
  assertSelectValuesKnown([...propertiesByKey.values()], properties, stored, { writerKind: "user" });
}

export function assertValidStepProperties(
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  databaseId: string,
  stored: Record<string, unknown> | null,
): void {
  assertWritableProposalPropertyKeys(properties, propertiesByKey, databaseId);
  assertProposalSelectValuesKnown(properties, propertiesByKey, stored);
}

/**
 * A `database` envelope's top-level `properties`: writable keys and, single-step only, known options. Multi-step top
 * level mirrors the primary step, already checked against the stored item.
 */
export function assertValidEnvelopeProperties(
  envelope: { properties: Record<string, unknown>; operations?: readonly unknown[] },
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  databaseId: string,
): void {
  assertWritableProposalPropertyKeys(envelope.properties, propertiesByKey, databaseId);
  if (envelope.operations === undefined) assertProposalSelectValuesKnown(envelope.properties, propertiesByKey, null);
}

function errorDetails(err: { details?: unknown }): Record<string, unknown> {
  return typeof err.details === "object" && err.details !== null ? { ...err.details } : {};
}

/** Re-raises validation, permission and cardinality failures of a single-item check with the step's `ref` in `details`. */
export async function withStepRef<T>(ref: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(err.message, { ...errorDetails(err), ref });
    if (err instanceof CardinalityViolationError) {
      throw new CardinalityViolationError(err.message, { ...errorDetails(err), ref });
    }
    if (err instanceof ForbiddenError) throw new ForbiddenError(err.message, { ...errorDetails(err), ref }, err.code);
    throw err;
  }
}

/** A step's relations without `{ ref }` targets (not yet created items); a key holding only refs stays, empty. */
export function existingItemRelations(step: ProposalStep): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(effectiveStepRelations(step)).map(([key, list]) => [
      key,
      list.filter((target): target is string => typeof target === "string"),
    ]),
  );
}

export function assertStepDatabaseWritable(
  step: ProposalStep,
  database: DatabaseRow | null,
  field: string,
): DatabaseRow {
  if (!database || database.archivedAt) throw stepError(step, "its database does not exist or is archived", field);
  if (database.ownerModuleId && ALLDOTS_READ_ONLY_MODULE_IDS.includes(database.ownerModuleId)) {
    throw stepError(step, "its database is not a writable target database", field);
  }
  return database;
}

export function assertUpdateStepShape(
  step: ProposalStep,
  prepared: { patch: Record<string, unknown>; deferredKeys: string[] },
  stored: ItemRow,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
): void {
  const properties = step.properties ?? {};
  const required = new Set(Object.keys(properties));
  for (const [key, value] of Object.entries(prepared.patch)) {
    if (
      propertiesByKey.get(key)?.owner === "user" &&
      !isDeepStrictEqual(stored.properties[key] ?? null, value ?? null)
    ) {
      required.add(key);
    }
  }
  for (const key of prepared.deferredKeys) required.add(key);
  for (const key of required) {
    if (!Object.hasOwn(step.before?.properties ?? {}, key)) {
      throw stepError(step, `before does not hold the current value of property '${key}'`, key);
    }
    if (prepared.deferredKeys.includes(key) && !Object.hasOwn(properties, key)) continue;
    if (!Object.hasOwn(step.after?.properties ?? {}, key)) {
      throw stepError(step, `after does not hold the new value of property '${key}'`, key);
    }
    if (!isDeepStrictEqual(prepared.patch[key] ?? null, step.after?.properties?.[key] ?? null)) {
      throw stepError(step, `after differs from property '${key}'`, key);
    }
  }
  for (const key of Object.keys(step.after?.properties ?? {})) {
    if (!Object.hasOwn(step.before?.properties ?? {}, key) || propertiesByKey.get(key)?.owner !== "user") {
      throw stepError(step, `after contains unsupported property '${key}'`, key);
    }
    if (prepared.deferredKeys.includes(key) && !Object.hasOwn(properties, key)) {
      throw stepError(step, `after cannot predict allocated property '${key}'`, key);
    }
    if (
      Object.hasOwn(prepared.patch, key) &&
      !isDeepStrictEqual(prepared.patch[key] ?? null, step.after?.properties?.[key] ?? null)
    ) {
      throw stepError(step, `after differs from property '${key}'`, key);
    }
    if (
      !Object.hasOwn(prepared.patch, key) &&
      isDeepStrictEqual(step.before?.properties?.[key] ?? null, stored.properties[key] ?? null)
    ) {
      throw stepError(step, `after contains unwritten property '${key}'`, key);
    }
  }
  for (const key of Object.keys(step.before?.properties ?? {})) {
    if (propertiesByKey.get(key)?.owner !== "user")
      throw stepError(step, `before contains unsupported property '${key}'`, key);
  }
  const relations = effectiveStepRelations(step);
  for (const [key, before] of Object.entries(step.before?.relations ?? {})) {
    if (propertiesByKey.get(key)?.type !== "relation") {
      throw stepError(step, `before contains unsupported relation '${key}'`, key);
    }
    if (new Set(before).size !== before.length) {
      throw stepError(step, `relation '${key}' contains duplicate targets`, key);
    }
  }
  for (const [key, targets] of Object.entries(relations)) {
    if (!Object.hasOwn(step.before?.relations ?? {}, key)) {
      throw stepError(step, `before does not hold the current targets of relation '${key}'`, key);
    }
    if (!Object.hasOwn(step.after?.relations ?? {}, key)) {
      throw stepError(step, `after does not hold the new targets of relation '${key}'`, key);
    }
    if (step.relations?.[key] && !isDeepStrictEqual(step.relations[key], targets)) {
      throw stepError(step, `after differs from relation '${key}'`, key);
    }
    const keys = targets.map((target) => (typeof target === "string" ? `id:${target}` : `ref:${target.ref}`));
    const before = step.before?.relations?.[key] ?? [];
    if (new Set(keys).size !== keys.length || new Set(before).size !== before.length) {
      throw stepError(step, `relation '${key}' contains duplicate targets`, key);
    }
  }
}

/** Only a single-step `database` envelope may carry `pageSections`; any other is a `ValidationError` on it. */
export function assertValidEnvelopePageSections(envelope: ProposalEnvelope): void {
  if (envelope.pageSections === undefined) return;
  if (envelope.entityKind !== "database") {
    throw new ValidationError("Proposal page sections are only valid for entityKind 'database'", {
      field: "pageSections",
    });
  }
  if (envelope.operations !== undefined) {
    throw new ValidationError("A proposal with steps has no page sections", { field: "pageSections" });
  }
}
