import type { PoolClient } from "pg";
import type { ItemRow, PropertyRow } from "../types.js";
import { getDatabaseByModuleId, listDatabaseLabelsByIds } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabases } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionsByPropertyIds, listRelationsForItems } from "../chokePoint/relationsStore.js";
import { AREAS_MODULE_ID, COMPANIES_MODULE_ID, EVENTS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { DERIVED_VALUE_SOURCES } from "./derivedValueSources.js";

export interface DerivedValue {
  values: Array<{ id: string; title: string; color?: string | null; icon?: string | null }>;
  via: "project";
  projectIds: string[];
}
export interface DerivedValues {
  area?: DerivedValue;
  company?: DerivedValue;
}

async function readEdges(client: PoolClient, property: PropertyRow, ids: string[]): Promise<Map<string, string[]>> {
  const definition = (await getRelationDefinitionsByPropertyIds(client, [property.id])).get(property.id);
  const result = new Map<string, string[]>();
  if (!definition) return result;
  const sideA = definition.propertyIdA === property.id;
  const sources = new Set(ids);
  for (const edge of await listRelationsForItems(client, definition.id, ids)) {
    const source = sideA ? edge.itemA : edge.itemB;
    const target = sideA ? edge.itemB : edge.itemA;
    if (!sources.has(source)) continue;
    const bucket = result.get(source) ?? [];
    bucket.push(target);
    result.set(source, bucket);
  }
  return result;
}

export async function getDerivedValuesForItems(
  client: PoolClient,
  items: ItemRow[],
): Promise<Map<string, DerivedValues>> {
  const result = new Map<string, DerivedValues>();
  if (items.length === 0) return result;
  const labels = await listDatabaseLabelsByIds(client, [...new Set(items.map((item) => item.databaseId))]);
  const schemas = await listPropertiesByDatabases(
    client,
    labels.map((label) => label.id),
  );
  const projectsDatabase = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  const areasDatabase = await getDatabaseByModuleId(client, AREAS_MODULE_ID);
  if (!projectsDatabase) return result;
  const projectIdsByItem = new Map<string, string[]>();
  const databaseById = new Map(labels.map((label) => [label.id, label.ownerModuleId]));
  for (const source of DERIVED_VALUE_SOURCES) {
    const database = labels.find((label) => label.ownerModuleId === source.databaseKey);
    if (!database) continue;
    const property = schemas
      .get(database.id)
      ?.find((p) => p.key === source.projectPropertyKey && p.type === "relation");
    if (!property) continue;
    const ids = items.filter((item) => item.databaseId === database.id).map((item) => item.id);
    for (const [id, projectIds] of await readEdges(client, property, ids)) projectIdsByItem.set(id, projectIds);
  }
  const projectIds = [...new Set([...projectIdsByItem.values()].flat())];
  const projects = (await getItemsByIds(client, projectIds)).filter((item) => item.databaseId === projectsDatabase.id);
  const liveProjects = new Map(projects.map((item) => [item.id, item]));
  const targetSchemas = await listPropertiesByDatabases(client, [
    projectsDatabase.id,
    ...(areasDatabase ? [areasDatabase.id] : []),
  ]);
  const projectProperties = targetSchemas.get(projectsDatabase.id) ?? [];
  const areaProperty = projectProperties.find((p) => p.key === "area" && p.type === "relation");
  const companyProperty = projectProperties.find((p) => p.key === "company" && p.type === "relation");
  const areaEdges = areaProperty
    ? await readEdges(
        client,
        areaProperty,
        projects.map((p) => p.id),
      )
    : new Map<string, string[]>();
  const companyEdges = companyProperty
    ? await readEdges(
        client,
        companyProperty,
        projects.map((p) => p.id),
      )
    : new Map<string, string[]>();
  const targets = await getItemsByIds(client, [...new Set([...areaEdges.values(), ...companyEdges.values()].flat())]);
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  const targetLabels = await listDatabaseLabelsByIds(client, [...new Set(targets.map((target) => target.databaseId))]);
  const targetLabelById = new Map(targetLabels.map((label) => [label.id, label]));
  const areaKeys = new Set((areasDatabase ? targetSchemas.get(areasDatabase.id) : [])?.map((p) => p.key) ?? []);
  for (const item of items) {
    const paths = (projectIdsByItem.get(item.id) ?? []).filter((id) => liveProjects.has(id));
    const values: DerivedValues = {};
    for (const [kind, edges] of [
      ["area", areaEdges],
      ["company", companyEdges],
    ] as const) {
      if (kind === "company" && databaseById.get(item.databaseId) !== EVENTS_MODULE_ID) continue;
      const found = new Map<string, { id: string; title: string; color?: string | null; icon?: string | null }>();
      const contributing = new Set<string>();
      for (const projectId of paths)
        for (const targetId of edges.get(projectId) ?? []) {
          const target = targetsById.get(targetId);
          if (!target) continue;
          if (kind === "area" && target.databaseId !== areasDatabase?.id) continue;
          const label = targetLabelById.get(target.databaseId);
          if (kind === "company" && label?.ownerModuleId !== COMPANIES_MODULE_ID) continue;
          const titleValue = target.properties[label?.titlePropertyKey ?? ""];
          const entry: { id: string; title: string; color?: string | null; icon?: string | null } = {
            id: target.id,
            title: typeof titleValue === "string" ? titleValue : "",
          };
          if (kind === "area") {
            entry.color =
              areaKeys.has("color") && typeof target.properties.color === "string" ? target.properties.color : null;
            entry.icon =
              areaKeys.has("icon") && typeof target.properties.icon === "string" ? target.properties.icon : null;
          }
          found.set(target.id, entry);
          contributing.add(projectId);
        }
      if (found.size)
        values[kind] = {
          values: [...found.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
          via: "project",
          projectIds: [...contributing].sort(),
        };
    }
    if (values.area || values.company) result.set(item.id, values);
  }
  return result;
}
