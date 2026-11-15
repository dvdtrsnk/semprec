import type { PoolClient } from "pg";
import { z } from "zod";
import { PropertyOptionAddInputSchema } from "@semprec/shared";
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

/**
 * The select options a `database` proposal creates when its card is confirmed (issue gh-1994,
 * docs/adr/2026-11-15-a-database-proposal-may-create-select-options-when-it-is-confirmed.md). The envelope lists them
 * in `newOptions`, and a value of `properties` names one by its label as `{ newOption: "<label>" }` in the place of an
 * option key. The validation here is the one the Inbox tick, a revise and the confirm all run through
 * `assertValidProposalEnvelope`; the creation is the confirm's.
 */

type PropertiesByKey = ReadonlyMap<string, PropertyRow>;

/** A new option of an envelope as the add of the option checks it: the property it joins, its trimmed label, its color in upper case. */
interface ParsedNewOption {
  property: PropertyRow;
  label: string;
  color?: string;
}

/** The label and the color of an option as `property.option.add` accepts them: 1 to 60 characters a `jsonb` value can hold, `#RRGGBB`. */
const newOptionInputSchema = PropertyOptionAddInputSchema.pick({ label: true, color: true });

const newOptionValueSchema = z.strictObject({ newOption: z.string() });

/** The trimmed label a `{ newOption: "<label>" }` value names; `null` for any other value. */
function newOptionLabelOf(value: unknown): string | null {
  const parsed = newOptionValueSchema.safeParse(value);
  return parsed.success ? parsed.data.newOption.trim() : null;
}

/** Refuses `newOptions` on an envelope that cannot carry it: only a single-step `database` envelope creates the one item whose values name the options. */
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

/** At most `MAX_PROPOSAL_NEW_OPTIONS` options, each on a select or multi_select property of the target with a valid label and color, none twice. */
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

/** The declared option a `{ newOption }` value of `propertyKey` names, by its trimmed label; a value that names none is refused on the property. */
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
 * `properties` with each `{ newOption }` value of a select or multi_select property replaced by what `replace` returns
 * for its property key and label: a select value becomes that key (or `null`), a multi_select element becomes that key
 * (or is dropped when it is `null`). Every other value is returned as it is, so a map without a `{ newOption }` value
 * comes back equal.
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
 * What a single-step `database` envelope's `newOptions` and `{ newOption }` values must satisfy (issue gh-1994), checked
 * without a write: at most `MAX_PROPOSAL_NEW_OPTIONS` options, each on a select or multi_select property of the target,
 * with a label of 1 to 60 characters and, when given, a `#RRGGBB` color, none listed twice, every `{ newOption }` value
 * naming a listed option, and no option that a value names whose label another option of the property already has
 * (`OptionLabelExistsError`, whose `details.key` is the existing option, so the proposal can use it). A listed option
 * that no value names is not checked for its label: the confirm ignores it, so a card whose value was changed to the
 * existing option (after a person added it, or after the card was reopened) can be confirmed with the list unchanged.
 * The properties are read as the target's row holds them, without a lock; the confirm creates the option on the locked
 * row and refuses a label added since. Returns the envelope's `properties` with each `{ newOption }` value taken out
 * (a select value as `null`), which is what the check of the option keys reads.
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

/** What a `{ newOption }` value of `propertyKey` with `label` is called when the options are compared: the property key and the trimmed label. */
function newOptionIdentity(propertyKey: string, label: string): string {
  return JSON.stringify([propertyKey, label.trim()]);
}

/** The identity of every `{ newOption }` value in `properties`, a select value or an element of a multi_select array, whatever the property's type. */
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
 * `next`, the envelope a revise of a card writes, with the new options of the card's previous assistant envelope
 * carried over (issue gh-1994), as `carryPageSections` carries the page sections. A revise replaces the whole envelope
 * with one the caller composed from properties alone, and a revised `properties` that still holds a `{ newOption }`
 * value would be refused for naming an option `newOptions` does not list. Carried are the previous options that a
 * value of `next.properties` still names, and only when the revision keeps the destination: `next` lists none of its
 * own and both envelopes are single-step `database` envelopes with the same `target`. `previous` is the stored
 * envelope as read from the card (`aiProposal`, else `proposal`); one that is absent or does not parse carries
 * nothing. The inputs are not changed.
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

/** The key of the option of its property that each listed new option of `envelope` now matches by label, by `newOptionIdentity`. */
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

/** `properties` with each `{ newOption }` value whose identity is in `keys` replaced by that key; a multi_select element that becomes a key it already holds is dropped. */
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
 * The stored fields of a card that returns to `proposed` when its confirmation is undone (issue gh-1994): the
 * `proposal`, the assistant's `aiProposal` and the manual values `userOverrides`, rewritten so that every listed new
 * option an option of the property now has by its label (the one the undone confirm created, which the undo leaves in
 * the schema) is used by its key: each `{ newOption }` value becomes that key and the option leaves `newOptions`, which
 * is dropped when it is then empty. The card can then be confirmed again, because the envelope no longer asks to create
 * an option that exists, and the item it creates carries the same key. Only the fields that change are returned, so a
 * card without a listed option that now exists yields `{}`. The same rewrite is applied to the three fields, by the
 * keys each envelope's own list matches, so `userEditedKeys` stays what it was.
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
 * Adds `option` to its property in `client`'s transaction through the store function behind `property.option.add`
 * (`propertiesStore.addPropertyOption`: the row lock, the label and limit rules, the key) and sends the schema
 * invalidation of the property's database after the commit, as that operation does
 * (docs/adr/2026-11-10-select-options-change-on-a-schema-locked-database.md, section 6). Resolves to the key the
 * option got. Two things differ from the operation, for the reasons in
 * docs/adr/2026-11-15-a-database-proposal-may-create-select-options-when-it-is-confirmed.md: it queues no search
 * reindex of the database, because no item holds the new option and the confirm writes the item that does after the
 * option, in this transaction; and it does not call `chokePoint/propertyOps.ts`, which opens its own transaction and
 * which `inbox/` cannot import without the import cycle `no-choke-point-rollup-cycle` forbids.
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
 * Creates, in the confirm's transaction on `client` and before the item is written, the options that the values of
 * `properties` name as `{ newOption }`, and returns `properties` with each replaced by the key the option got
 * (issue gh-1994). Each listed option is created once, at its first use, through `addOption`, so the
 * rules and the row lock are those of `property.option.add`; an option that no value names is not created, which
 * is how a person who changed the value on the card leaves it out. A failure here or in the item write after it rolls
 * the options back with the confirm. An envelope without `newOptions` comes back unchanged.
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
