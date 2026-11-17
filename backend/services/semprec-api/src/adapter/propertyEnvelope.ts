import type { PropertyRow, ResolvedProperty } from "@semprec/data";

/**
 * `name` (and each select option's `label`) is replaced by its localized-metadata resolution, as in
 * `databaseEnvelope.ts`.
 */
export interface PropertyEnvelope {
  id: string;
  databaseId: string;
  key: string;
  name: string;
  type: PropertyRow["type"];
  config: Record<string, unknown>;
  locked: boolean;
  owner: PropertyRow["owner"];
  ownerProcess: string | null;
  migrationStatus: PropertyRow["migrationStatus"];
  options?: ResolvedProperty["options"];
}

export function toPropertyEnvelope(property: PropertyRow, resolved: ResolvedProperty): PropertyEnvelope {
  return {
    id: property.id,
    databaseId: property.databaseId,
    key: property.key,
    name: resolved.name,
    type: property.type,
    config: property.config,
    locked: property.locked,
    owner: property.owner,
    ownerProcess: property.ownerProcess,
    migrationStatus: property.migrationStatus,
    options: resolved.options,
  };
}
