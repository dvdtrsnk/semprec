import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { ProposalEnvelope, ProposalStep } from "./proposalEnvelope.js";
import { effectiveStepRelations } from "./proposalStepGraph.js";

/**
 * What a user changed on the assistant output: step `ref` -> key -> value (`primary` for single-step). A key is a
 * property key or one of `RESERVED_OVERRIDE_KEYS`: `relations` (relation key -> full replacement id list) and
 * `enabled`. An entry exists only while it differs from the assistant's value.
 *
 * This module is pure and imports neither `proposalActions.ts` nor the tick's writers, so both can use it.
 */
export type UserOverrides = Record<string, Record<string, unknown>>;

export const SINGLE_STEP_REF = "primary";

const NO_KEYS: ReadonlySet<string> = new Set();

export const RESERVED_OVERRIDE_KEYS: readonly string[] = ["relations", "enabled"];

export type RelationOverrides = Record<string, string[]>;

const relationOverridesSchema = z.record(z.string(), z.array(z.string().min(1)));

const userOverridesSchema = z.record(
  z.string(),
  z
    .record(z.string(), z.unknown())
    .refine(
      (values) => !Object.hasOwn(values, "relations") || relationOverridesSchema.safeParse(values.relations).success,
    )
    .refine((values) => !Object.hasOwn(values, "enabled") || typeof values.enabled === "boolean"),
);

/** Parses stored `userOverrides` (a JSONB boundary): absent or JSON null is no overrides; other malformed values throw. */
export function parseUserOverrides(value: unknown, proposalId: string): UserOverrides {
  if (value === null || value === undefined) return {};
  const parsed = userOverridesSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Malformed userOverrides on proposal ${proposalId}`);
  return parsed.data;
}

function stepOf(aiEnvelope: ProposalEnvelope, ref: string): ProposalStep | undefined {
  return aiEnvelope.operations?.find((candidate) => candidate.ref === ref);
}

function requireRefProperties(aiEnvelope: ProposalEnvelope, ref: string): Record<string, unknown> {
  if (!aiEnvelope.operations) {
    if (ref === SINGLE_STEP_REF) return aiEnvelope.properties;
  } else {
    const step = stepOf(aiEnvelope, ref);
    if (step) return step.properties ?? {};
  }
  throw new ValidationError(`Proposal has no step '${ref}'`, { ref, field: ref });
}

function aiRelationsOf(aiEnvelope: ProposalEnvelope, ref: string): Record<string, Array<string | { ref: string }>> {
  if (!aiEnvelope.operations) return ref === SINGLE_STEP_REF ? (aiEnvelope.relations ?? {}) : {};
  const step = stepOf(aiEnvelope, ref);
  return step ? effectiveStepRelations(step) : {};
}

function aiEnabledOf(aiEnvelope: ProposalEnvelope, ref: string): boolean {
  return stepOf(aiEnvelope, ref)?.enabled !== false;
}

/**
 * Whether `ids` equal the assistant's targets for `key` (any order, no step refs). Reads own keys only: `key` comes
 * from the request, and `constructor` or `toString` must not read as a list.
 */
function sameTargets(
  aiRelations: Record<string, ReadonlyArray<string | { ref: string }>>,
  key: string,
  ids: readonly string[],
): boolean {
  const held = Object.hasOwn(aiRelations, key) ? (aiRelations[key] ?? []) : [];
  const heldIds = held.filter((target): target is string => typeof target === "string");
  return heldIds.length === held.length && isDeepStrictEqual([...heldIds].sort(), [...ids].sort());
}

/** Reads own keys only, so a ref named like an `Object` member is not found. */
function valuesOf(overrides: UserOverrides, ref: string): Record<string, unknown> | undefined {
  return Object.hasOwn(overrides, ref) ? overrides[ref] : undefined;
}

/** A malformed relation list here is a defect: stored ones are parsed and the edit builds its own. */
function relationOverridesOf(values: Record<string, unknown> | undefined): RelationOverrides {
  return values === undefined || !Object.hasOwn(values, "relations")
    ? {}
    : relationOverridesSchema.parse(values.relations);
}

function enabledOverrideOf(values: Record<string, unknown> | undefined): boolean | undefined {
  return values === undefined || !Object.hasOwn(values, "enabled") ? undefined : z.boolean().parse(values.enabled);
}

export function fieldOverridesOf(overrides: UserOverrides, ref: string): Record<string, unknown> {
  const values = valuesOf(overrides, ref) ?? {};
  return Object.fromEntries(Object.entries(values).filter(([key]) => !RESERVED_OVERRIDE_KEYS.includes(key)));
}

function differsFromAi(aiProperties: Record<string, unknown>, key: string, value: unknown): boolean {
  return !Object.hasOwn(aiProperties, key) || !isDeepStrictEqual(value, aiProperties[key]);
}

/**
 * `current` with `edits` applied, keeping only values that differ from the assistant's (refs left empty are dropped).
 * A relation list replaces only its own key's list. Throws a `ValidationError` for a ref the assistant's envelope lacks.
 */
export function mergeUserOverrides(
  aiEnvelope: ProposalEnvelope,
  current: UserOverrides,
  edits: UserOverrides,
): UserOverrides {
  const merged: Array<[string, Record<string, unknown>]> = [];
  for (const ref of new Set([...Object.keys(current), ...Object.keys(edits)])) {
    const aiProperties = requireRefProperties(aiEnvelope, ref);
    const currentValues = valuesOf(current, ref);
    const editedValues = valuesOf(edits, ref);
    const fields = { ...fieldOverridesOf(current, ref), ...fieldOverridesOf(edits, ref) };
    const aiRelations = aiRelationsOf(aiEnvelope, ref);
    const relations = { ...relationOverridesOf(currentValues), ...relationOverridesOf(editedValues) };
    const enabled = enabledOverrideOf(editedValues) ?? enabledOverrideOf(currentValues);
    const changedLists = Object.entries(relations).filter(([key, ids]) => !sameTargets(aiRelations, key, ids));
    const kept: Array<[string, unknown]> = Object.entries(fields).filter(([key, value]) =>
      differsFromAi(aiProperties, key, value),
    );
    if (changedLists.length > 0) kept.push(["relations", Object.fromEntries(changedLists)]);
    if (enabled !== undefined && enabled !== aiEnabledOf(aiEnvelope, ref)) kept.push(["enabled", enabled]);
    if (kept.length > 0) merged.push([ref, Object.fromEntries(kept)]);
  }
  return Object.fromEntries(merged);
}

/**
 * Sorted `ref.key` of every override that differs from the assistant's value (`ref.relations.<key>`, `ref.enabled`
 * for relations and switches). Keys in `hiddenKeys` and fields of a switched-off step are not edits; the switch is.
 */
export function computeUserEditedKeys(
  aiEnvelope: ProposalEnvelope,
  userOverrides: UserOverrides,
  hiddenKeys: ReadonlySet<string> = NO_KEYS,
): string[] {
  const keys: string[] = [];
  for (const [ref, values] of Object.entries(userOverrides)) {
    const aiProperties = requireRefProperties(aiEnvelope, ref);
    const enabled = enabledOverrideOf(values);
    if (enabled !== undefined && enabled !== aiEnabledOf(aiEnvelope, ref)) keys.push(`${ref}.enabled`);
    if ((enabled ?? aiEnabledOf(aiEnvelope, ref)) === false) continue;
    for (const [key, value] of Object.entries(fieldOverridesOf(userOverrides, ref))) {
      if (!hiddenKeys.has(key) && differsFromAi(aiProperties, key, value)) keys.push(`${ref}.${key}`);
    }
    const aiRelations = aiRelationsOf(aiEnvelope, ref);
    for (const [key, ids] of Object.entries(relationOverridesOf(values))) {
      if (!hiddenKeys.has(key) && !sameTargets(aiRelations, key, ids)) keys.push(`${ref}.relations.${key}`);
    }
  }
  return keys.sort();
}

/**
 * The envelope a confirm would write: the assistant's envelope with each ref's overrides laid over its `properties`,
 * relation lists and `enabled`. The primary step is mirrored to the top level, and `update` values also go to `after`.
 * For `pageContent`/`relation` envelopes an override must replace a key the assistant already holds. `pseudoKeys` are
 * editor-only and stay out of the envelope. Throws a `ValidationError` for an unknown ref or such a key; whether the
 * values suit the destination is left to envelope validation. The input is not changed.
 */
export function composeEffectiveEnvelope(
  aiEnvelope: ProposalEnvelope,
  userOverrides: UserOverrides,
  pseudoKeys: ReadonlySet<string> = NO_KEYS,
): ProposalEnvelope {
  const fieldsOf = (ref: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fieldOverridesOf(userOverrides, ref)).filter(([key]) => !pseudoKeys.has(key)));
  for (const ref of Object.keys(userOverrides)) {
    requireRefProperties(aiEnvelope, ref);
    // A recording card's optional parameters (language, Event, project, ...) are absent from the assistant's envelope.
    if (aiEnvelope.entityKind === "database" || aiEnvelope.entityKind === "transcription") continue;
    for (const key of Object.keys(fieldOverridesOf(userOverrides, ref))) {
      if (!pseudoKeys.has(key) && !Object.hasOwn(aiEnvelope.properties, key)) {
        throw new ValidationError(`Proposal of kind '${aiEnvelope.entityKind}' has no field '${key}'`, {
          ref,
          field: key,
        });
      }
    }
  }
  if (!aiEnvelope.operations) {
    const relations = relationOverridesOf(valuesOf(userOverrides, SINGLE_STEP_REF));
    return {
      ...aiEnvelope,
      properties: { ...aiEnvelope.properties, ...fieldsOf(SINGLE_STEP_REF) },
      ...(Object.keys(relations).length > 0 ? { relations: { ...aiEnvelope.relations, ...relations } } : {}),
    };
  }
  const operations = aiEnvelope.operations.map((step): ProposalStep => {
    const values = fieldsOf(step.ref);
    const relations = relationOverridesOf(valuesOf(userOverrides, step.ref));
    const enabled = enabledOverrideOf(valuesOf(userOverrides, step.ref));
    const hasRelations = Object.keys(relations).length > 0;
    if (Object.keys(values).length === 0 && !hasRelations && enabled === undefined) return step;
    const isUpdate = step.op === "update";
    const nextRelations = replaceRelations(step.relations, relations, !isUpdate);
    return {
      ...step,
      ...(Object.keys(values).length > 0 ? { properties: { ...step.properties, ...values } } : {}),
      ...(nextRelations === undefined ? {} : { relations: nextRelations }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(isUpdate && (Object.keys(values).length > 0 || hasRelations)
        ? {
            after: {
              ...step.after,
              ...(Object.keys(values).length > 0 ? { properties: { ...step.after?.properties, ...values } } : {}),
              ...(hasRelations ? { relations: { ...step.after?.relations, ...relations } } : {}),
            },
          }
        : {}),
    };
  });
  const primary = aiEnvelope.operations.find((step) => step.role === "primary");
  const primaryValues = primary ? fieldsOf(primary.ref) : undefined;
  return {
    ...aiEnvelope,
    operations,
    properties: primaryValues ? { ...aiEnvelope.properties, ...primaryValues } : aiEnvelope.properties,
  };
}

/**
 * A step's `relations` with `replacements` laid over. For an `update` step (`touchAll` false) only keys it already
 * holds are touched: its new targets live in `after.relations`, which validation requires to agree.
 */
function replaceRelations(
  current: ProposalStep["relations"],
  replacements: RelationOverrides,
  touchAll: boolean,
): ProposalStep["relations"] {
  const replaced = Object.entries(replacements).filter(([key]) => touchAll || Object.hasOwn(current ?? {}, key));
  return replaced.length === 0 ? current : { ...current, ...Object.fromEntries(replaced) };
}

/** `primary` for a single-step envelope, else its primary step's ref. */
export function destinationRef(envelope: ProposalEnvelope): string | undefined {
  return envelope.operations ? envelope.operations.find((step) => step.role === "primary")?.ref : SINGLE_STEP_REF;
}

export interface RetainedOverrides {
  userOverrides: UserOverrides;
  userEditedKeys: string[];
  reset: boolean;
  /** Sorted `ref.key` of overrides dropped for the destination; not those that became equal to `nextEnvelope`'s. */
  droppedKeys: string[];
}

/**
 * Which `overrides` survive replacing the assistant's envelope with `nextEnvelope`. A changed `entityKind` or `target`
 * drops all (`reset`). Otherwise only overrides of the destination's own ref whose key is in `targetPropertyKeys`
 * survive; other steps' are dropped since their databases are unknown here. A surviving value equal to
 * `nextEnvelope`'s is no longer an edit and is not reported as dropped. A `null` previous envelope is no change.
 */
export function retainOverridesForEnvelope(
  previousAiEnvelope: { entityKind: string; target: string } | null,
  nextEnvelope: ProposalEnvelope,
  overrides: UserOverrides,
  targetPropertyKeys: readonly string[],
): RetainedOverrides {
  const reset =
    previousAiEnvelope !== null &&
    (previousAiEnvelope.entityKind !== nextEnvelope.entityKind || previousAiEnvelope.target !== nextEnvelope.target);
  const validKeys = new Set(targetPropertyKeys);
  const ref = destinationRef(nextEnvelope);
  const kept: Array<[string, unknown]> = [];
  const droppedKeys: string[] = [];
  for (const [overrideRef, values] of Object.entries(overrides)) {
    for (const [key, value] of Object.entries(values)) {
      if (!reset && overrideRef === ref && validKeys.has(key)) kept.push([key, value]);
      else droppedKeys.push(`${overrideRef}.${key}`);
    }
  }
  const userOverrides =
    ref === undefined || kept.length === 0
      ? {}
      : mergeUserOverrides(nextEnvelope, {}, { [ref]: Object.fromEntries(kept) });
  return {
    userOverrides,
    userEditedKeys: computeUserEditedKeys(nextEnvelope, userOverrides),
    reset,
    droppedKeys: droppedKeys.sort(),
  };
}

export interface ThreadRevisionOverrides extends RetainedOverrides {
  /** The revised envelope, with each manual key's previous assistant value kept. */
  aiProposal: ProposalEnvelope;
}

/**
 * What a revision in an Inbox item thread does with manual values. A changed destination drops them all. Otherwise a
 * manual key present in `revised.properties` takes the revised value while `aiProposal` keeps the previous assistant
 * value for it; a key absent from `revised` keeps its manual value (omission is not an instruction; clearing is an
 * explicit `null`). Manual values under other refs are dropped and reported.
 */
export function retainOverridesForThreadRevision(
  previousAiEnvelope: ProposalEnvelope | null,
  revised: ProposalEnvelope,
  overrides: UserOverrides,
): ThreadRevisionOverrides {
  const reset =
    previousAiEnvelope !== null &&
    (previousAiEnvelope.entityKind !== revised.entityKind || previousAiEnvelope.target !== revised.target);
  const ref = previousAiEnvelope === null || reset ? undefined : destinationRef(previousAiEnvelope);
  const droppedKeys = Object.entries(overrides)
    .filter(([overrideRef]) => overrideRef !== ref)
    .flatMap(([overrideRef, values]) => Object.keys(values).map((key) => `${overrideRef}.${key}`))
    .sort();
  const manual = ref === undefined ? {} : (valuesOf(overrides, ref) ?? {});
  const aiProperties = { ...revised.properties };
  const kept: Array<[string, unknown]> = [];
  for (const key of Object.keys(manual)) {
    // An omitted key is not an instruction to remove a field, so the user's value stays; clearing is an explicit `null`.
    kept.push([key, Object.hasOwn(revised.properties, key) ? revised.properties[key] : manual[key]]);
    if (previousAiEnvelope !== null && Object.hasOwn(previousAiEnvelope.properties, key)) {
      aiProperties[key] = previousAiEnvelope.properties[key];
    } else {
      delete aiProperties[key];
    }
  }
  const aiProposal: ProposalEnvelope = { ...revised, properties: aiProperties };
  const userOverrides =
    kept.length === 0 ? {} : mergeUserOverrides(aiProposal, {}, { [SINGLE_STEP_REF]: Object.fromEntries(kept) });
  return {
    aiProposal,
    userOverrides,
    userEditedKeys: computeUserEditedKeys(aiProposal, userOverrides),
    reset,
    droppedKeys,
  };
}
