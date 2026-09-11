import type { PropertyRow, ResolvedProperty } from "@semprec/data";

/**
 * The wire shape every property read/write returns (issue #240) — the raw row, with `name`
 * (and, for select/multi_select, each option's `label`) replaced by its localized-metadata
 * resolution (issue #35's `resolveProperty`), same reasoning as `databaseEnvelope.ts`.
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
