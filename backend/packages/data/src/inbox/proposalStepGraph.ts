import { ValidationError } from "../errors.js";
import type { ProposalStep } from "./inboxTickAction.js";

/** Step-graph checks for multi-step proposal envelopes: ref uniqueness, the primary step, optional-step pruning and ref cycles. */

export function stepError(step: ProposalStep, message: string, field: string): ValidationError {
  return new ValidationError(`Proposal step '${step.ref}': ${message}`, { ref: step.ref, field });
}

/** The relation values that the executor will write for this step. */
export function effectiveStepRelations(step: ProposalStep): NonNullable<ProposalStep["relations"]> {
  return step.op === "update" ? { ...step.relations, ...step.after?.relations } : (step.relations ?? {});
}

/** The `{ ref }` targets of a step's relations, with the relation key each sits under. */
function stepRefTargets(step: ProposalStep): Array<{ key: string; ref: string }> {
  const targets: Array<{ key: string; ref: string }> = [];
  for (const [key, list] of Object.entries(effectiveStepRelations(step))) {
    for (const target of list) if (typeof target !== "string") targets.push({ key, ref: target.ref });
  }
  return targets;
}

/**
 * The steps that are validated: a disabled step is skipped, and so is an `optional` step that no
 * active step refers to, or that refers to a skipped step. A non-optional step that refers to a
 * skipped step, or to no step at all, is a `ValidationError`.
 */
export function selectActiveSteps(steps: ProposalStep[]): ProposalStep[] {
  const refs = new Set<string>();
  for (const step of steps) {
    if (step.ref.trim().length === 0) throw stepError(step, "ref must not be empty", "ref");
    if (refs.has(step.ref)) throw stepError(step, "ref is used by more than one step", "ref");
    refs.add(step.ref);
  }
  const primaries = steps.filter((step) => step.role === "primary");
  if (primaries.length !== 1) {
    const offender = primaries[1] ?? steps[0]!;
    throw stepError(offender, `exactly one step must have role 'primary', found ${primaries.length}`, "role");
  }
  const active = new Set(steps.filter((step) => step.enabled !== false).map((step) => step.ref));
  if (!active.has(primaries[0]!.ref)) throw stepError(primaries[0]!, "the primary step cannot be disabled", "enabled");

  const isReferred = (ref: string) =>
    steps.some(
      (other) => other.ref !== ref && active.has(other.ref) && stepRefTargets(other).some((t) => t.ref === ref),
    );
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (!active.has(step.ref)) continue;
      const skipped = stepRefTargets(step).find((target) => !active.has(target.ref));
      const removable = step.optional === true && step.role !== "primary";
      if (skipped && !removable) {
        throw stepError(step, `relation '${skipped.key}' refers to the skipped step '${skipped.ref}'`, skipped.key);
      }
      if (removable && (skipped || !isReferred(step.ref))) {
        active.delete(step.ref);
        changed = true;
      }
    }
  }
  for (const step of steps) {
    if (!active.has(step.ref)) continue;
    for (const { key, ref } of stepRefTargets(step)) {
      if (!refs.has(ref)) throw stepError(step, `relation '${key}' refers to '${ref}', which is not a step`, key);
      if (ref === step.ref) throw stepError(step, `relation '${key}' refers to the step itself`, key);
    }
  }
  return steps.filter((step) => active.has(step.ref));
}

/** Rejects a cycle in the ref graph of the active steps. */
export function assertNoRefCycle(activeSteps: ProposalStep[]): void {
  const byRef = new Map(activeSteps.map((step) => [step.ref, step]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (step: ProposalStep): void => {
    state.set(step.ref, "visiting");
    for (const { key, ref } of stepRefTargets(step)) {
      const next = byRef.get(ref);
      if (!next) continue;
      if (state.get(ref) === "visiting")
        throw stepError(step, `relation '${key}' closes a cycle through '${ref}'`, key);
      if (!state.has(ref)) visit(next);
    }
    state.set(step.ref, "done");
  };
  for (const step of activeSteps) if (!state.has(step.ref)) visit(step);
}
