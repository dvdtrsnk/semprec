import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { ProposalEnvelope, ProposalStep } from "./proposalEnvelope.js";
import { effectiveStepRelations } from "./proposalStepGraph.js";

/**
 * What a user changed on a Processing proposal's assistant output, as stored in its `userOverrides`: step `ref` ->
 * key -> value. A single-step envelope has the one ref `primary`
 * (`docs/adr/2026-10-25-multi-step-proposal-envelope.md`). A key is a property key, or one of the two reserved keys
 * `relations` (relation property key -> the full replacement list of target item ids) and `enabled` (whether the
 * step is carried out), which no property key may be named (`RESERVED_OVERRIDE_KEYS`, issue #1920). An entry exists
 * only while its value differs from the assistant's value for the same ref and key; a value set back to the
 * assistant's is dropped.
 *
 * This module is pure and imports neither `proposalActions.ts` nor the tick's writers, so both can use it.
 */
export type UserOverrides = Record<string, Record<string, unknown>>;

/** The ref a single-step envelope answers to. */
const SINGLE_STEP_REF = "primary";

const NO_KEYS: ReadonlySet<string> = new Set();

/** The keys of a ref's overrides that are not property keys: the relation lists and the step switch. */
export const RESERVED_OVERRIDE_KEYS: readonly string[] = ["relations", "enabled"];

/** Relation property key -> the target item ids that replace the assistant's list. */
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

/** Parses a row's stored `userOverrides` (a JSONB boundary): an absent or JSON null value is "no overrides"; anything else malformed throws. */
export function parseUserOverrides(value: unknown, proposalId: string): UserOverrides {
  if (value === null || value === undefined) return {};
  const parsed = userOverridesSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Malformed userOverrides on proposal ${proposalId}`);
  return parsed.data;
}

/** The step `ref` addresses in the assistant's envelope; `undefined` for the `primary` of a single-step envelope and for an unknown ref. */
function stepOf(aiEnvelope: ProposalEnvelope, ref: string): ProposalStep | undefined {
  return aiEnvelope.operations?.find((candidate) => candidate.ref === ref);
}

/** The properties a ref addresses in the assistant's envelope: the top-level ones for `primary` of a single-step envelope, a step's own otherwise. */
function requireRefProperties(aiEnvelope: ProposalEnvelope, ref: string): Record<string, unknown> {
  if (!aiEnvelope.operations) {
    if (ref === SINGLE_STEP_REF) return aiEnvelope.properties;
  } else {
    const step = stepOf(aiEnvelope, ref);
    if (step) return step.properties ?? {};
  }
  throw new ValidationError(`Proposal has no step '${ref}'`, { ref, field: ref });
}

/** The relation targets the assistant's envelope holds for `ref`, by relation property key: the top-level `relations` of a single-step envelope, a step's effective ones otherwise. */
function aiRelationsOf(aiEnvelope: ProposalEnvelope, ref: string): Record<string, Array<string | { ref: string }>> {
  if (!aiEnvelope.operations) return ref === SINGLE_STEP_REF ? (aiEnvelope.relations ?? {}) : {};
  const step = stepOf(aiEnvelope, ref);
  return step ? effectiveStepRelations(step) : {};
}

/** Whether the assistant's envelope carries out the step `ref`: every step but one marked `enabled: false`, and the one step of a single-step envelope. */
function aiEnabledOf(aiEnvelope: ProposalEnvelope, ref: string): boolean {
  return stepOf(aiEnvelope, ref)?.enabled !== false;
}

/**
 * Whether `ids` are the targets the assistant already holds for the relation `key`: the same item ids, in any order,
 * and no step reference. Reads own keys only: the key comes from the request, and one named like an `Object` member
 * (`constructor`, `toString`) holds no list, so it is not read as one.
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

/** The override values of `ref`, or `undefined` when there are none. Reads own keys only, so a ref named like an `Object` member is not found. */
function valuesOf(overrides: UserOverrides, ref: string): Record<string, unknown> | undefined {
  return Object.hasOwn(overrides, ref) ? overrides[ref] : undefined;
}

/** The relation lists in a ref's override values; `parseUserOverrides` has checked a stored one, and the edit builds its own, so a malformed one is a defect and throws. */
function relationOverridesOf(values: Record<string, unknown> | undefined): RelationOverrides {
  return values === undefined || !Object.hasOwn(values, "relations")
    ? {}
    : relationOverridesSchema.parse(values.relations);
}

/** The step switch in a ref's override values, or `undefined` when none was set. */
function enabledOverrideOf(values: Record<string, unknown> | undefined): boolean | undefined {
  return values === undefined || !Object.hasOwn(values, "enabled") ? undefined : z.boolean().parse(values.enabled);
}

/** A ref's override values without the reserved keys: the property values and pseudo fields. */
export function fieldOverridesOf(overrides: UserOverrides, ref: string): Record<string, unknown> {
  const values = valuesOf(overrides, ref) ?? {};
  return Object.fromEntries(Object.entries(values).filter(([key]) => !RESERVED_OVERRIDE_KEYS.includes(key)));
}

/** Whether `value` is an edit: the assistant has no value for `key`, or a different one. */
function differsFromAi(aiProperties: Record<string, unknown>, key: string, value: unknown): boolean {
  return !Object.hasOwn(aiProperties, key) || !isDeepStrictEqual(value, aiProperties[key]);
}

/**
 * The `userOverrides` after `edits` is applied to `current`, restricted to values that differ from the assistant's:
 * a value set back to the assistant's own is dropped, and so is a ref left with nothing. A relation list replaces
 * the list of its own relation key only, and an `enabled` switch replaces the one of its step. Throws a
 * `ValidationError` naming a ref of `edits` or `current` that the assistant's envelope does not have.
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
 * The `ref.key` of every override that differs from the assistant's value for it, sorted: a property or pseudo
 * field as `ref.key`, a relation list as `ref.relations.<propertyKey>` and a step switch as `ref.enabled`. An
 * override equal to the assistant's value is not an edit. Neither is one whose key is in `hiddenKeys`, the editor
 * fields a condition hides (issue #1928), nor any field or relation of a step that is switched off; the switch
 * itself is counted. Throws a `ValidationError` naming a ref the assistant's envelope does not have.
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
 * The envelope a confirm would write: the assistant's envelope with each ref's overrides laid over that ref's
 * `properties`, its relation lists replaced and its `enabled` switch set. A multi-step envelope's primary step is
 * mirrored into the top-level `properties`, and an `update` step's value and relations are also written to `after`,
 * the copies its validation compares. The input is not changed. A `pageContent` or `relation` envelope has no
 * database to name its fields, so an override there must replace a key the assistant's envelope already holds. A
 * key in `pseudoKeys` (an editor field that is no property of the destination, issue #1928) is a value for the
 * editor only: it stays out of the envelope, and the key check above does not apply to it. Relation lists on an
 * envelope that cannot carry them are left for the envelope validation to refuse. Throws a `ValidationError`
 * naming a ref the envelope does not have, or such a key. Whether the values suit the destination is the envelope
 * validation's question, not this function's.
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
    if (aiEnvelope.entityKind === "database") continue;
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
 * A step's `relations` with the lists of `replacements` laid over it. An `update` step's `relations` are only
 * touched for a key it already holds (`touchAll` false): its new targets are in `after.relations`, and validation
 * requires the two to agree where both exist. Answers `current` itself when nothing is replaced.
 */
function replaceRelations(
  current: ProposalStep["relations"],
  replacements: RelationOverrides,
  touchAll: boolean,
): ProposalStep["relations"] {
  const replaced = Object.entries(replacements).filter(([key]) => touchAll || Object.hasOwn(current ?? {}, key));
  return replaced.length === 0 ? current : { ...current, ...Object.fromEntries(replaced) };
}

/** The ref of the step that holds the envelope's own destination: `primary` for a single-step envelope, else its primary step's ref. */
export function destinationRef(envelope: ProposalEnvelope): string | undefined {
  return envelope.operations ? envelope.operations.find((step) => step.role === "primary")?.ref : SINGLE_STEP_REF;
}

/** What `retainOverridesForEnvelope` keeps and reports. */
export interface RetainedOverrides {
  /** The overrides that survive, restricted to values that still differ from `nextEnvelope`'s. */
  userOverrides: UserOverrides;
  /** The `ref.key` of every surviving override, as `computeUserEditedKeys` lists them. */
  userEditedKeys: string[];
  /** Whether the destination, the pair `entityKind` and `target`, differs from the previous assistant envelope's. */
  reset: boolean;
  /** The sorted `ref.key` of every override dropped because of the destination; not those that became equal to `nextEnvelope`'s own value. */
  droppedKeys: string[];
}

/**
 * Decides which of the user's `overrides` survive when the assistant's envelope is replaced by `nextEnvelope`. They
 * only make sense for the destination they were typed for: when `entityKind` or `target` differs from
 * `previousAiEnvelope`'s, all of them are dropped and `reset` is true. For the same destination, an override
 * survives when it addresses the envelope's own destination (`primary`, or the primary step of a multi-step
 * envelope) and its key is one of `targetPropertyKeys`, the properties of the destination: the target database's
 * property keys, or for a `pageContent` envelope the keys of its `properties`. The overrides of other steps are
 * dropped, because their databases are not known here. A surviving value equal to `nextEnvelope`'s own is no
 * longer an edit and leaves `userOverrides` without being reported as dropped. A `previousAiEnvelope` of `null`
 * (the card had no envelope) is no change of destination.
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

/** What `retainOverridesForThreadRevision` decides: the assistant's new envelope and the manual values that stay. */
export interface ThreadRevisionOverrides extends RetainedOverrides {
  /** The assistant's envelope after the revision (`aiProposal`): the revised envelope, with each manual key's previous assistant value kept. */
  aiProposal: ProposalEnvelope;
}

/**
 * Decides what a revision made in an Inbox item thread (issue #1938) does with the user's manual values. `revised`
 * is the whole envelope the assistant wrote, so for a key the user edited it holds the manual value the assistant saw
 * unless the instruction changed it. The rules:
 *
 * - When the destination (`entityKind` or `target`) differs from `previousAiEnvelope`'s, every manual value is dropped
 *   (`reset`, issue #1924) and `aiProposal` is `revised`.
 * - Otherwise, for each manual key of the destination's own ref whose key is in `revised.properties`, the manual value
 *   becomes the revised value, so a key the instruction did not touch stays protected and one it changed stays the
 *   user's, and `aiProposal` keeps the previous assistant value of that key (the key is absent from it when the
 *   assistant had none). A manual value that equals that assistant value is no longer an edit and leaves the overrides.
 *   A key that `revised` does not hold keeps the manual value it has, because an omitted key is not an instruction:
 *   the revised envelope is meant to hold every property, and a user's value is never lost by leaving it out. The
 *   instruction clears a field by writing `null` for it, which is a changed value like any other.
 * - Every other key of `aiProposal` is the revised value.
 * - A manual value under any other ref is dropped and reported, because `revised` has no such step.
 *
 * `revised` is a single-step envelope. A `previousAiEnvelope` of `null` (the card had no envelope) has no manual
 * value to keep. `droppedKeys` lists the `ref.key` of every value dropped by the first or the last rule, sorted. The
 * inputs are not changed.
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
    // A key the revised envelope omits is one the instruction did not touch (a partial envelope is no instruction to
    // remove a field), so the user's value stays. Clearing a field is written as an explicit `null`.
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
