import type { ViewRow } from "@alldots/data";

/**
 * Unlike databases and properties, a view `name` has no localized-metadata entry (views carry no
 * `key`), so it is projected verbatim.
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
