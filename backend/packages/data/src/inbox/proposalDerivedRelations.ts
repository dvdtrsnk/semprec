import { GUARDED_DERIVED_VALUE_SOURCES } from "../derived/derivedValueSources.js";
import { ValidationError } from "../errors.js";
import type { DatabaseRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";

// Relation values that an item with a project inherits from the project are not the item's own to set, and the choke
// point refuses to write them (`assertNotDerivedValueWrite`, issue gh-1662, which keeps the rule table in
// `GUARDED_DERIVED_VALUE_SOURCES`). A proposal is validated before anything is written, so these checks refuse the same
// combination in an envelope up front instead of at confirm (issue gh-1991).

function derivedRelationError(field: string): ValidationError {
  return new ValidationError(`'${field}' is derived from the item's project, so a proposal cannot set both`, {
    field,
    code: "derivedRelation",
  });
}

/**
 * Refuses a `database` envelope that sets a relation the choke point derives from the project and also sets the
 * project: for each entry of `GUARDED_DERIVED_VALUE_SOURCES` of `targetDatabase`, a non-empty `relations.<property>`
 * next to a non-empty `relations.<project property>` is a `ValidationError` (`details.field` the derived relation's
 * key, `details.code` `derivedRelation`). Without a project the value is the item's own and stays valid, and an
 * envelope whose database has no guarded relation, or that has no `relations`, is not affected. Only the envelope's
 * top-level `relations` are read; the relations of the steps of a multi-step envelope are not.
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

/**
 * Refuses a `journalEntry` envelope's `properties` that set both `projectId` and `areaId`: the area of a Journal entry
 * is derived from its project, so it is the entry's own value only when there is no project. The `ValidationError`
 * names the Journal day's relation `area` (`details.field`, `details.code` `derivedRelation`), not the property key.
 */
export function assertJournalEntryAreaNotDerived(properties: { areaId?: string; projectId?: string }): void {
  if (properties.areaId !== undefined && properties.projectId !== undefined) throw derivedRelationError("area");
}
