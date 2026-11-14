import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { ConflictError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { appendHistoryEntry, isFinalInvalid, readAiProposal } from "./inboxTickAction.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import {
  assertValidEnvelopeForCard,
  lockLiveProposal,
  unsupportedEntityKindError,
  type ProposalActionConfig,
} from "./proposalActions.js";
import {
  RESERVED_OVERRIDE_KEYS,
  composeEffectiveEnvelope,
  computeUserEditedKeys,
  destinationRef,
  mergeUserOverrides,
  parseUserOverrides,
  type RelationOverrides,
  type UserOverrides,
} from "./proposalOverrides.js";
import { buildEditorValues, toProposalWarnings, visibleKeys, type ProposalWarning } from "./editorSchema.js";
import { loadCardEditorRules } from "./proposalEditorRules.js";
import { selectActiveSteps } from "./proposalStepGraph.js";

/**
 * The user's edit of the values on a proposal card (issue #1892), split out of `proposalActions.ts` to keep that
 * file under the ESLint line cap. `proposalActions.ts` re-exports `updateProposalValuesWithClient` and
 * `UpdateProposalValuesInput`, so callers import them from there. The shared helpers this module takes from
 * `proposalActions.ts` (`lockLiveProposal`, `assertValidEnvelopeForCard`, `unsupportedEntityKindError`) are used only
 * inside functions, so the import cycle does not matter at module load.
 */

export interface UpdateProposalValuesInput {
  /** The values to set, as step ref -> property key -> value. A single-step envelope has the one ref `primary`. */
  set?: UserOverrides;
  /** The relation lists to replace (issue #1920), as step ref -> relation property key -> the full list of target item ids. */
  relations?: Record<string, RelationOverrides>;
  /** The steps to switch on or off (issue #1920), as step ref -> `{ enabled }`. The primary step cannot be switched off. */
  steps?: Record<string, { enabled: boolean }>;
  /** The card's `updatedAt` as the client read it; a different current value refuses the edit with a `ConflictError`. */
  ifVersion?: string;
}

/** What a values edit answers: the saved card and the required fields it still lacks (issue #1928). */
export interface UpdateProposalValuesResult {
  item: ItemRow;
  warnings: ProposalWarning[];
}

/** The request as `userOverrides`-shaped edits: each ref's `set` values, its `relations` under the reserved key `relations` and its step switch under `enabled`. */
function requestedOverrides(input: UpdateProposalValuesInput): UserOverrides {
  const refs = new Set([
    ...Object.keys(input.set ?? {}),
    ...Object.keys(input.relations ?? {}),
    ...Object.keys(input.steps ?? {}),
  ]);
  return Object.fromEntries(
    [...refs].map((ref) => {
      const lists = Object.hasOwn(input.relations ?? {}, ref) ? input.relations?.[ref] : undefined;
      const step = Object.hasOwn(input.steps ?? {}, ref) ? input.steps?.[ref] : undefined;
      return [
        ref,
        {
          ...(Object.hasOwn(input.set ?? {}, ref) ? input.set?.[ref] : {}),
          ...(lists === undefined ? {} : { relations: lists }),
          ...(step === undefined ? {} : { enabled: step.enabled }),
        },
      ];
    }),
  );
}

/**
 * `PATCH /api/proposals/:id/values` (issue #1892): the user types values over the assistant's proposal. The
 * assistant's output stays in `aiProposal` (a legacy card without one gets it from `proposal` in this same
 * write), the user's values in `userOverrides`, the keys that differ from the assistant's in `userEditedKeys`, and
 * `proposal` holds the effective envelope, so confirm reads it as it is. A value set back to the assistant's own
 * leaves `userOverrides` and `userEditedKeys`.
 *
 * `set` may also hold the pseudo fields of the card's editor schema (issue #1928: an editor field that is no
 * property of the destination, such as `allDay` or `followupTask`). They are stored in `userOverrides` and counted
 * in `userEditedKeys` like any value, are kept out of the effective envelope and are never written to the created
 * item. A field the schema hides under a condition (`when`) is not counted in `userEditedKeys`, though its value
 * stays in `userOverrides` for when the condition holds again. The result carries a `required` warning for every
 * visible required field the card still has no value for; such an edit is saved all the same.
 *
 * `relations` and `steps` (issue #1920) are edited in the same request, validated and written with `set` or not at
 * all. A relation list replaces the whole list of its relation property on that step, a step switch turns the step
 * on or off; both are stored in `userOverrides` beside the field values under the reserved keys `relations` and
 * `enabled`, and counted in `userEditedKeys` as `ref.relations.<propertyKey>` and `ref.enabled` while they differ
 * from the assistant's envelope. A switched-off step's fields and relations are not counted. `set` may not use a
 * reserved key. The primary step cannot be switched off, a relation or switch of an unknown ref is refused like a
 * value of one, and the validation of the effective envelope is the one confirm runs, so a target that does not
 * exist or a relation the target database does not allow is the same `ValidationError`.
 *
 * Runs in the caller's transaction under the proposal's row lock. Allowed from `proposed`, `needsClarification` and
 * `invalid` while the card has an envelope to edit; a `confirmed` or `rejected` card, a final `invalid` one
 * (`sourceDeleted`, issue #1482) and a card in any other status are refused with a `ValidationError`, as is a card
 * with no envelope. A `ConflictError` carrying the current card answers an `ifVersion` that is no longer the card's
 * `updatedAt`. The effective envelope is validated as confirm validates it (`assertValidEnvelopeForCard`), so an
 * unknown ref or key, a credential key of an MCP server and every other rejected value are `ValidationError`s that
 * name the field. Because that validation skips a step the proposal does not carry out (disabled, or optional and
 * referred to by no active step), a value or a relation list for such a step is refused with a `ValidationError`
 * naming its ref instead of being stored unchecked; a step is switched on in the request that first sets
 * something on it, or before. A successful edit sets the status to `proposed`, clears the
 * `invalidReason` of an `invalid` card and adds a history entry of kind `userEdit` listing the key of every value,
 * relation list and step switch of the request: `ref.key`, `ref.relations.<propertyKey>` and `ref.enabled`.
 */
export async function updateProposalValuesWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  input: UpdateProposalValuesInput,
): Promise<UpdateProposalValuesResult> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) {
    throw new ValidationError(`Cannot edit a locked proposal (status '${status}')`, { field: "status" });
  }
  if (status !== "proposed" && status !== "needsClarification" && status !== "invalid") {
    throw new ValidationError(`Cannot edit a proposal in status '${String(status)}'`, { field: "status" });
  }
  if (isFinalInvalid(proposal.properties)) {
    throw new ValidationError("Cannot edit a proposal whose source Inbox item was deleted", { field: "status" });
  }
  if (input.ifVersion !== undefined && input.ifVersion !== proposal.updatedAt) {
    throw new ConflictError("Proposal was modified since ifVersion was read", { current: proposal });
  }
  const set = input.set ?? {};
  for (const [ref, values] of Object.entries(set)) {
    const reserved = Object.keys(values).find((key) => RESERVED_OVERRIDE_KEYS.includes(key));
    if (reserved !== undefined) {
      throw new ValidationError(
        `'${reserved}' is not a value of step '${ref}': send relation lists as 'relations' and step switches as 'steps'`,
        { ref, field: reserved },
      );
    }
  }
  const touchedKeys = [
    ...Object.entries(set).flatMap(([ref, values]) => Object.keys(values).map((key) => `${ref}.${key}`)),
    ...Object.entries(input.relations ?? {}).flatMap(([ref, lists]) =>
      Object.keys(lists).map((key) => `${ref}.relations.${key}`),
    ),
    ...Object.keys(input.steps ?? {}).map((ref) => `${ref}.enabled`),
  ];
  if (touchedKeys.length === 0) {
    const field =
      input.set === undefined && input.relations !== undefined
        ? "relations"
        : input.set === undefined && input.steps !== undefined
          ? "steps"
          : "set";
    throw new ValidationError("The request must set at least one value, relation list or step switch", { field });
  }

  const aiEnvelope = readAiProposal(proposal.properties, proposal.id);
  if (aiEnvelope === null)
    throw new ValidationError("Proposal has no computed envelope to edit", { field: "proposal" });
  if ("unknownKind" in aiEnvelope) throw unsupportedEntityKindError(aiEnvelope.entityKind);

  const primaryRef = destinationRef(aiEnvelope);
  const switchedOff = Object.entries(input.steps ?? {}).find(([ref, step]) => ref === primaryRef && !step.enabled);
  if (switchedOff) {
    throw new ValidationError(`The primary step '${switchedOff[0]}' cannot be switched off`, {
      ref: switchedOff[0],
      field: "enabled",
    });
  }

  const userOverrides = mergeUserOverrides(
    aiEnvelope,
    parseUserOverrides(proposal.properties.userOverrides, proposal.id),
    requestedOverrides(input),
  );
  const rules = await loadCardEditorRules(client, proposal.properties.kind, aiEnvelope);
  const effective = composeEffectiveEnvelope(aiEnvelope, userOverrides, rules?.pseudoKeys);
  await assertValidEnvelopeForCard(client, config, proposal, effective);
  // The validation above skips a disabled step and an optional step that nothing active refers to, so it would not
  // check a value typed into one (a credential of an MCP server, an unknown key). Such a step cannot be edited.
  if (effective.operations) {
    const active = new Set(selectActiveSteps(effective.operations).map((step) => step.ref));
    const skipped = [...Object.keys(set), ...Object.keys(input.relations ?? {})].find((ref) => !active.has(ref));
    if (skipped !== undefined) {
      const message = `Proposal step '${skipped}' is not part of the proposal, so its values and relations cannot be edited`;
      throw new ValidationError(message, { ref: skipped, field: skipped });
    }
  }

  // The editor schema's rules (issue #1928): a field hidden by a condition is not counted as edited, and a visible
  // required field without a value is a warning, never a refusal, so a half-filled card can be saved.
  const editorValues = buildEditorValues(effective, userOverrides);
  const visible = new Set(rules ? visibleKeys(rules.schema, editorValues) : []);
  const hiddenKeys = new Set(
    rules
      ? rules.schema.groups
          .flatMap((group) => group.fields.map((field) => field.key))
          .filter((key) => !visible.has(key))
      : [],
  );
  const warnings = rules ? toProposalWarnings(rules.schema, editorValues) : [];

  const materializesAiProposal =
    proposal.properties.aiProposal === undefined || proposal.properties.aiProposal === null;
  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        proposal: effective,
        ...(materializesAiProposal ? { aiProposal: aiEnvelope } : {}),
        userOverrides,
        userEditedKeys: computeUserEditedKeys(aiEnvelope, userOverrides, hiddenKeys),
        status: "proposed",
        ...(status === "invalid" ? { invalidReason: null } : {}),
        history: appendHistoryEntry(proposal.properties.history, "Edited by user.", "user", {
          kind: "userEdit",
          keys: touchedKeys,
        }),
      },
    },
    {
      allowedSystemKeys: [
        "proposal",
        ...(materializesAiProposal ? ["aiProposal"] : []),
        "userOverrides",
        "userEditedKeys",
        "status",
        ...(status === "invalid" ? ["invalidReason"] : []),
        "history",
      ],
    },
  );
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return { item: updated, warnings };
}
