import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { ConflictError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { appendHistoryEntry, isFinalInvalid, readAiProposal } from "./inboxTickAction.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { referencedItemIdsOf } from "./proposalReferences.js";
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

// The user's edit of a card's values; re-exported from `proposalActions.ts`. Helpers taken from `proposalActions.ts`
// are used only inside functions, so the import cycle is harmless at module load.

export interface UpdateProposalValuesInput {
  /** Step ref -> property key -> value (`primary` for a single-step envelope). */
  set?: UserOverrides;
  /** Step ref -> relation property key -> full replacement list of target item ids. */
  relations?: Record<string, RelationOverrides>;
  /** Step ref -> `{ enabled }`. The primary step cannot be switched off. */
  steps?: Record<string, { enabled: boolean }>;
  /** A value other than the card's `updatedAt` refuses the edit with a `ConflictError`. */
  ifVersion?: string;
}

/** The saved card and the required fields it still lacks. */
export interface UpdateProposalValuesResult {
  item: ItemRow;
  warnings: ProposalWarning[];
}

/** The request as `userOverrides`-shaped edits, with relation lists under `relations` and step switches under `enabled`. */
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
 * `PATCH /api/proposals/:id/values`: the user types values over the assistant's proposal. The assistant's output
 * stays in `aiProposal`, the user's values go to `userOverrides`, differing keys to `userEditedKeys`, and `proposal`
 * holds the effective envelope that confirm reads.
 *
 * Editor pseudo fields are stored but never written to the item; fields hidden by a `when` condition are not counted.
 * Missing required fields are warnings, not refusals. `relations` and `steps` are stored under the reserved keys; a
 * value for an inactive step is refused, since validation would skip it.
 *
 * Runs under the card's row lock. A stale `ifVersion` is a `ConflictError`. Success sets `proposed`, clears
 * `invalidReason` and appends a `userEdit` entry.
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
  if (input.ifVersion !== undefined && input.ifVersion !== proposal.version) {
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
  // The validation above skips inactive steps, so it would not check a value typed into one (an MCP credential, an
  // unknown key). Such a step cannot be edited.
  if (effective.operations) {
    const active = new Set(selectActiveSteps(effective.operations).map((step) => step.ref));
    const skipped = [...Object.keys(set), ...Object.keys(input.relations ?? {})].find((ref) => !active.has(ref));
    if (skipped !== undefined) {
      const message = `Proposal step '${skipped}' is not part of the proposal, so its values and relations cannot be edited`;
      throw new ValidationError(message, { ref: skipped, field: skipped });
    }
  }

  // A field hidden by a condition is not counted as edited, and a visible required field without a value is a warning,
  // never a refusal, so a half-filled card can be saved.
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
        referencedItemIds: referencedItemIdsOf(effective),
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
        "referencedItemIds",
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
