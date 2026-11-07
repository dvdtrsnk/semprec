import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { ChokePointError, ValidationError } from "../errors.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { prepareUserItemPatch } from "../chokePoint/itemWrites.js";
import { getCalendarClock } from "../calendarTime.js";
import type { ProposalEnvelope, ProposalStep } from "./proposalEnvelope.js";
import { effectiveStepRelations, selectActiveSteps } from "./proposalStepGraph.js";
import { isWorkspaceUpdateEligible } from "./proposalWorkspaceContext.js";

/** Forms server-owned baselines only for freshly computed multi-step proposals. */
export async function prepareComputedUpdates(
  client: PoolClient,
  envelope: ProposalEnvelope,
  captureDate: unknown,
): Promise<ProposalEnvelope> {
  if (!envelope.operations) return envelope;
  const active = selectActiveSteps(envelope.operations);
  const seen = new Set<string>();
  for (const step of active) {
    if ((step.op !== "update" && step.op !== "link") || !step.itemId) continue;
    if (seen.has(step.itemId)) throw new ValidationError("Repeated mutation of a proposal target");
    seen.add(step.itemId);
  }
  const updated = new Map<string, ProposalStep>();
  // The tenant zone for the Events preparation, read and validated once in this tenant transaction.
  let timezone: string | undefined;
  for (const step of active) {
    if (step.op !== "update" || !step.itemId) continue;
    const [item] = await getItemsByIds(client, [step.itemId]);
    if (!item || item.deletedAt) throw new ValidationError("Proposal update target is unavailable");
    const database = await getDatabase(client, item.databaseId);
    if (!database || database.archivedAt) throw new ValidationError("Proposal update database is unavailable");
    if (!(await isWorkspaceUpdateEligible(client, database.ownerModuleId, item.properties, captureDate)))
      throw new ValidationError("Proposal update target is no longer eligible");
    const properties = await listPropertiesByDatabase(client, database.id);
    const byKey = new Map(properties.map((property) => [property.key, property]));
    const patch = step.properties ?? {};
    let prepared: { patch: Record<string, unknown>; deferredKeys: string[] } = { patch: {}, deferredKeys: [] };
    if (Object.keys(patch).length > 0) {
      // Read outside the mapping below: a settings failure is not a refused proposal and propagates as is.
      timezone ??= (await getCalendarClock(client)).zone;
      try {
        prepared = await prepareUserItemPatch(properties, patch, database, item, timezone);
      } catch (error) {
        if (!(error instanceof ChokePointError)) throw error;
        throw new ValidationError("Proposal update cannot be prepared");
      }
    }
    const required = new Set(Object.keys(patch));
    for (const [key, value] of Object.entries(prepared.patch)) {
      if (byKey.get(key)?.owner === "user" && !isDeepStrictEqual(item.properties[key] ?? null, value ?? null))
        required.add(key);
    }
    for (const key of prepared.deferredKeys) required.add(key);
    const beforeProperties: Record<string, unknown> = {};
    const afterProperties: Record<string, unknown> = {};
    const eligibilityKey =
      database.ownerModuleId === "projects" ? "status" : database.ownerModuleId === "events" ? "date" : null;
    if (eligibilityKey) beforeProperties[eligibilityKey] = item.properties[eligibilityKey] ?? null;
    for (const key of required) {
      beforeProperties[key] = item.properties[key] ?? null;
      if (!prepared.deferredKeys.includes(key) || Object.hasOwn(patch, key))
        afterProperties[key] = prepared.patch[key] ?? null;
    }
    const relations = effectiveStepRelations(step);
    const beforeRelations: Record<string, string[]> = {};
    for (const key of Object.keys(relations)) {
      const property = byKey.get(key);
      if (!property || property.type !== "relation" || property.owner === "system")
        throw new ValidationError("Proposal update relation is unavailable");
      const definition = await getRelationDefinitionByPropertyId(client, property.id);
      if (!definition) throw new ValidationError("Proposal update relation is unavailable");
      const edges = await listRelationsForItem(client, definition.id, item.id);
      beforeRelations[key] = edges.map((edge) => otherSide(edge, item.id)).sort();
    }
    updated.set(step.ref, {
      ...step,
      before: { properties: beforeProperties, relations: beforeRelations },
      after: { properties: afterProperties, relations },
    });
  }
  return { ...envelope, operations: envelope.operations.map((step) => updated.get(step.ref) ?? step) };
}
