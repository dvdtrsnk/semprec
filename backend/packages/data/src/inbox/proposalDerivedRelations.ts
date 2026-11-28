import { GUARDED_DERIVED_VALUE_SOURCES } from "../derived/derivedValueSources.js";
import { ValidationError } from "../errors.js";
import type { DatabaseRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";

// Relations an item inherits from its project are refused by the choke point (`assertNotDerivedValueWrite`); these
// checks refuse the same combination when the envelope is validated rather than at confirm.

function derivedRelationError(field: string): ValidationError {
  return new ValidationError(`'${field}' is derived from the item's project, so a proposal cannot set both`, {
    field,
    code: "derivedRelation",
  });
}

/**
 * Refuses a `database` envelope that sets both a relation in `GUARDED_DERIVED_VALUE_SOURCES` and its project relation
 * (`details.code` `derivedRelation`). Only top-level `relations` are checked, not those of steps.
 */
export function assertNoDerivedRelations(targetDatabase: DatabaseRow, envelope: ProposalEnvelope): void {
  const relations = envelope.relations ?? {};
  for (const source of GUARDED_DERIVED_VALUE_SOURCES) {
    if (source.databaseKey !== targetDatabase.key) continue;
    if ((relations[source.propertyKey]?.length ?? 0) > 0 && (relations[source.projectPropertyKey]?.length ?? 0) > 0) {
      throw derivedRelationError(source.propertyKey);
    }
  }
}
