import type { PoolClient } from "pg";
import { z } from "zod";
import { PropertyOptionAddInputSchema } from "@alldots/shared";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { runAfterCommit } from "../db/pool.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { OptionLabelExistsError, ValidationError } from "../errors.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { loadFacetMetadata } from "../views/facetQuery.js";
import type { DatabaseRow, PropertyRow } from "../types.js";
import {
  MAX_PROPOSAL_NEW_OPTIONS,
  proposalEnvelopeSchema,
  type ProposalEnvelope,
  type ProposalNewOption,
} from "./proposalEnvelope.js";
import { SINGLE_STEP_REF } from "./proposalOverrides.js";

// Select options a `database` proposal creates on confirm: listed in `newOptions` and named by a property value as
// `{ newOption: "<label>" }` in place of an option key. Validation runs in tick, revise and confirm via
// `assertValidProposalEnvelope`; only the confirm creates.

type PropertiesByKey = ReadonlyMap<string, PropertyRow>;

interface ParsedNewOption {
  property: PropertyRow;
  label: string;
  color?: string;
}

const newOptionInputSchema = PropertyOptionAddInputSchema.pick({ label: true, color: true });

const newOptionValueSchema = z.strictObject({ newOption: z.string() });

function newOptionLabelOf(value: unknown): string | null {
  const parsed = newOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data.newOption.trim() : null;
}

/** Only a single-step `database` envelope may carry `newOptions`. */
export function assertValidEnvelopeNewOptionsPlacement(envelope: ProposalEnvelope): void {
  if (envelope.newOptions === undefined) return;
  if (envelope.entityKind !== "database") {
    throw new ValidationError("Proposal new options are only valid for entityKind 'database'", {
      field: "newOptions",
    });
  }
  if (envelope.operations !== undefined) {
    throw new ValidationError("A proposal with steps has no new options", { field: "newOptions" });
  }
}

function parseNewOptions(options: readonly ProposalNewOption[], propertiesByKey: PropertiesByKey): ParsedNewOption[] {
  if (options.length > MAX_PROPOSAL_NEW_OPTIONS) {
    throw new ValidationError(`A proposal creates at most ${MAX_PROPOSAL_NEW_OPTIONS} new options`, {
      field: "newOptions",
      reason: "new_option_limit",
    });
  }
  const seen = new Set<string>();
  return options.map((option) => {
    const property = propertiesByKey.get(option.propertyKey);
    if (!property || (property.type !== "select" && property.type !== "multi_select")) {
      throw new ValidationError(
        `A new option names '${option.propertyKey}', which is not a select or multi_select property of the target database`,
        { field: "newOptions" },
      );
    }
    const input = newOptionInputSchema.safeParse({
      label: option.label,
      ...(option.color === undefined ? {} : { color: option.color }),
    });
    if (!input.success) {
      throw new ValidationError(
        `A new option for '${option.propertyKey}' needs a label of 1 to 60 characters and, when it has a color, a #RRGGBB one`,
        { field: "newOptions" },
      );
    }
    const { label, color } = input.data;
    const identity = JSON.stringify([property.key, propertiesStore.foldLabel(label)]);
    if (seen.has(identity)) {
      throw new ValidationError(`A proposal lists a new option for '${property.key}' with the same label twice`, {
        field: "newOptions",
      });
    }
    seen.add(identity);
    return { property, label, ...(color === undefined ? {} : { color }) };
  });
}

/** Resolves a `{ newOption }` value to its listed option by trimmed label; an unlisted one is refused on the property. */
function newOptionLookup(options: readonly ParsedNewOption[]): (propertyKey: string, label: string) => ParsedNewOption {
  return (propertyKey, label) => {
    const option = options.find((candidate) => candidate.property.key === propertyKey && candidate.label === label);
    if (!option) {
      throw new ValidationError(
        `Property '${propertyKey}' names the new option '${label}', which newOptions does not list`,
        {
          field: propertyKey,
        },
      );
    }
    return option;
  };
}

/**
 * `properties` with each select/multi_select `{ newOption }` value replaced by `replace(key, label)`; a multi_select
 * element replaced by `null` is dropped. Other values are returned as they are.
 */
async function rewriteNewOptionValues(
  properties: Record<string, unknown>,
  propertiesByKey: PropertiesByKey,
  replace: (propertyKey: string, label: string) => Promise<string | null>,
): Promise<Record<string, unknown>> {
  const rewritten = { ...properties };
  for (const [key, value] of Object.entries(properties)) {
    const type = propertiesByKey.get(key)?.type;
    if (type === "select") {
      const label = newOptionLabelOf(value);
      if (label !== null) rewritten[key] = await replace(key, label);
    } else if (type === "multi_select" && Array.isArray(value)) {
      const items: unknown[] = value;
      const next: unknown[] = [];
      for (const item of items) {
        const label = newOptionLabelOf(item);
        if (label === null) {
          next.push(item);
          continue;
        }
        const created = await replace(key, label);
        if (created !== null) next.push(created);
      }
      rewritten[key] = next;
    }
  }
  return rewritten;
}

/**
 * Validates `newOptions` and `{ newOption }` values without writing: limits, select/multi_select properties, labels,
 * colors, no duplicates, every value naming a listed option, and no named option whose label already exists on the
 * property (`OptionLabelExistsError` with `details.key`, so the proposal can use it). Unnamed listed options are not
 * label-checked: confirm ignores them, so a card switched to the existing option stays confirmable. Reads unlocked;
 * the confirm re-checks on the locked row. Returns `properties` with `{ newOption }` values removed (select as `null`).
 */
export async function assertValidEnvelopeNewOptions(
  envelope: ProposalEnvelope,
  database: DatabaseRow,
  propertiesByKey: PropertiesByKey,
): Promise<Record<string, unknown>> {
  const options = parseNewOptions(envelope.newOptions ?? [], propertiesByKey);
  const lookup = newOptionLookup(options);
  const named = new Set<ParsedNewOption>();
  const properties = await rewriteNewOptionValues(envelope.properties, propertiesByKey, (propertyKey, label) => {
    named.add(lookup(propertyKey, label));
    return Promise.resolve(null);
  });
  if (named.size > 0) {
    const { catalogResolver } = await loadFacetMetadata();
    for (const option of options.filter((candidate) => named.has(candidate))) {
      await propertiesStore.assertPropertyOptionLabelFree(option.label, option.property, database, catalogResolver);
    }
  }
  return properties;
}

function newOptionIdentity(propertyKey: string, label: string): string {
  return JSON.stringify([propertyKey, label.trim()]);
}

function namedNewOptionIdentities(properties: Record<string, unknown>): Set<string> {
  const identities = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    for (const candidate of Array.isArray(value) ? (value as unknown[]) : [value]) {
      const label = newOptionLabelOf(candidate);
      if (label !== null) identities.add(newOptionIdentity(key, label));
    }
  }
  return identities;
}

/**
 * `next` (a revise's envelope, composed from properties alone) with the previous assistant envelope's new options
 * still named by its values carried over; otherwise those values would be refused. Only when the revision keeps the
 * destination: `next` lists none of its own and both are single-step `database` envelopes with the same `target`.
 */
export function carryNewOptions(previous: unknown, next: ProposalEnvelope): ProposalEnvelope {
  if (next.newOptions !== undefined || next.entityKind !== "database" || next.operations !== undefined) return next;
  const parsed = proposalEnvelopeSchema.safeParse(previous);
  if (!parsed.success) return next;
  const { entityKind, target, operations, newOptions } = parsed.data;
  if (newOptions === undefined || entityKind !== "database" || operations !== undefined || target !== next.target) {
    return next;
  }
  const named = namedNewOptionIdentities(next.properties);
  const carried = newOptions.filter((option) => named.has(newOptionIdentity(option.propertyKey, option.label)));
  return carried.length === 0 ? next : { ...next, newOptions: carried };
}

/** The existing option key each listed new option of `envelope` now matches by label, keyed by `newOptionIdentity`. */
async function existingKeysOfNewOptions(client: PoolClient, envelope: ProposalEnvelope): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (envelope.entityKind !== "database" || envelope.operations !== undefined || !envelope.newOptions?.length) {
    return found;
  }
  const database = await databasesStore.getDatabase(client, envelope.target);
  if (!database) return found;
  const propertiesByKey = new Map(
    (await propertiesStore.listPropertiesByDatabase(client, database.id)).map((property) => [property.key, property]),
  );
  const { catalogResolver } = await loadFacetMetadata();
  for (const option of envelope.newOptions) {
    const property = propertiesByKey.get(option.propertyKey);
    if (!property) continue;
    try {
      await propertiesStore.assertPropertyOptionLabelFree(option.label.trim(), property, database, catalogResolver);
    } catch (err) {
      if (!(err instanceof OptionLabelExistsError)) throw err;
      found.set(newOptionIdentity(option.propertyKey, option.label), err.details.key);
    }
  }
  return found;
}

/** Replaces `{ newOption }` values whose identity is in `keys` by that key; a duplicate multi_select element is dropped. */
function adoptKeysInValues(
  properties: Record<string, unknown>,
  keys: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const adopt = (propertyKey: string, value: unknown): unknown => {
    const label = newOptionLabelOf(value);
    return label === null ? value : (keys.get(newOptionIdentity(propertyKey, label)) ?? value);
  };
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      if (!Array.isArray(value)) return [key, adopt(key, value)];
      const items: unknown[] = value;
      const next: unknown[] = [];
      for (const item of items) {
        const adopted = adopt(key, item);
        if (typeof adopted !== "string" || !next.includes(adopted)) next.push(adopted);
      }
      return [key, next];
    }),
  );
}

function adoptKeysInEnvelope(envelope: ProposalEnvelope, keys: ReadonlyMap<string, string>): ProposalEnvelope {
  const { newOptions, ...rest } = envelope;
  const remaining = (newOptions ?? []).filter(
    (option) => !keys.has(newOptionIdentity(option.propertyKey, option.label)),
  );
  return {
    ...rest,
    properties: adoptKeysInValues(envelope.properties, keys),
    ...(remaining.length > 0 ? { newOptions: remaining } : {}),
  };
}

/**
 * For a card returning to `proposed` on undo: rewrites `proposal`, `aiProposal` and `userOverrides` so each listed new
 * option that now exists by label (the undone confirm created it and undo keeps it) is used by key and leaves
 * `newOptions` (dropped when empty). The card can then be confirmed again with the same key. Returns only changed
 * fields; each envelope uses its own list, so `userEditedKeys` stays valid.
 */
export async function adoptCreatedNewOptions(
  client: PoolClient,
  card: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  let overrideKeys: ReadonlyMap<string, string> | undefined;
  for (const field of ["aiProposal", "proposal"] as const) {
    const parsed = proposalEnvelopeSchema.safeParse(card[field]);
    if (!parsed.success) continue;
    const keys = await existingKeysOfNewOptions(client, parsed.data);
    if (keys.size === 0) continue;
    patch[field] = adoptKeysInEnvelope(parsed.data, keys);
    // The overrides lie over the assistant's envelope, so its keys come first.
    overrideKeys ??= keys;
  }
  const overrides = card.userOverrides;
  if (overrideKeys !== undefined && typeof overrides === "object" && overrides !== null) {
    const own: unknown = (overrides as Record<string, unknown>)[SINGLE_STEP_REF];
    if (typeof own === "object" && own !== null) {
      const values = own as Record<string, unknown>;
      const fields = Object.fromEntries(
        Object.entries(values).filter(([key]) => key !== "relations" && key !== "enabled"),
      );
      patch.userOverrides = {
        ...overrides,
        [SINGLE_STEP_REF]: { ...values, ...adoptKeysInValues(fields, overrideKeys) },
      };
    }
  }
  return patch;
}

/**
 * Adds `option` through `propertiesStore.addPropertyOption` (row lock, label/limit rules, key) and sends the schema
 * invalidation after commit, like `property.option.add`. Unlike that operation it queues no search reindex (no item
 * holds the option yet; the confirm writes it next in this transaction), and it bypasses `chokePoint/propertyOps.ts`,
 * which opens its own transaction and would create the import cycle `no-choke-point-rollup-cycle` forbids.
 */
async function addOption(
  client: PoolClient,
  option: ParsedNewOption,
  catalogResolver: Awaited<ReturnType<typeof loadFacetMetadata>>["catalogResolver"],
  actingUserId: string | undefined,
): Promise<string> {
  const written = await propertiesStore.addPropertyOption(
    client,
    option.property.id,
    { label: option.label, ...(option.color === undefined ? {} : { color: option.color }) },
    catalogResolver,
  );
  const databaseId = written.property.databaseId;
  runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId }));
  return written.optionKey;
}

/**
 * In the confirm transaction, before the item write, creates each option a `{ newOption }` value names (once, at first
 * use) and returns `properties` with those values replaced by the new keys. A listed option no value names is not
 * created. A later failure rolls the options back with the confirm.
 */
export async function createEnvelopeNewOptions(
  client: PoolClient,
  envelope: ProposalEnvelope,
  properties: Record<string, unknown>,
  actingUserId?: string,
): Promise<Record<string, unknown>> {
  if (envelope.newOptions === undefined) return properties;
  const propertiesByKey = new Map(
    (await propertiesStore.listPropertiesByDatabase(client, envelope.target)).map((property) => [
      property.key,
      property,
    ]),
  );
  const lookup = newOptionLookup(parseNewOptions(envelope.newOptions, propertiesByKey));
  const { catalogResolver } = await loadFacetMetadata();
  const created = new Map<ParsedNewOption, string>();
  return rewriteNewOptionValues(properties, propertiesByKey, async (propertyKey, label) => {
    const option = lookup(propertyKey, label);
    const known = created.get(option);
    if (known !== undefined) return known;
    const key = await addOption(client, option, catalogResolver, actingUserId);
    created.set(option, key);
    return key;
  });
}
