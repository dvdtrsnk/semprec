import type { ViewRow } from "@semprec/data";

/**
 * The wire shape every view read/write returns (issue #155). Unlike `databaseEnvelope.ts`/
 * `propertyEnvelope.ts`, `name` is a plain user-supplied string with no localized-metadata
 * catalog entry behind it (views carry no `key`), so it is projected verbatim.
 */
export interface ViewEnvelope {
  id: string;
  databaseId: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  isDefault: boolean;
  ownerModuleId: string | null;
  createdBy: ViewRow["createdBy"];
  creatorProjectItemId: string | null;
}

export function toViewEnvelope(view: ViewRow): ViewEnvelope {
  return {
    id: view.id,
    databaseId: view.databaseId,
    type: view.type,
    name: view.name,
    config: view.config,
    isDefault: view.isDefault,
    ownerModuleId: view.ownerModuleId,
    createdBy: view.createdBy,
    creatorProjectItemId: view.creatorProjectItemId,
  };
}
