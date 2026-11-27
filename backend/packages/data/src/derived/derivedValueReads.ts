import type { PoolClient } from "pg";
import type { ItemRow, PropertyRow } from "../types.js";
import { getDatabaseByModuleId, listDatabaseLabelsByIds } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabases } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionsByPropertyIds, listRelationsForItems } from "../chokePoint/relationsStore.js";
import { COMPANIES_MODULE_ID, EVENTS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { DERIVED_VALUE_SOURCES } from "./derivedValueSources.js";

export interface DerivedValue {
  values: Array<{ id: string; title: string }>;
  via: "project";
  projectIds: string[];
}
export interface DerivedValues {
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
  const projectProperties = (await listPropertiesByDatabases(client, [projectsDatabase.id])).get(projectsDatabase.id);
  const companyProperty = projectProperties?.find((p) => p.key === "company" && p.type === "relation");
  const companyEdges = companyProperty
    ? await readEdges(
        client,
        companyProperty,
        projects.map((p) => p.id),
      )
    : new Map<string, string[]>();
  const targets = await getItemsByIds(client, [...new Set([...companyEdges.values()].flat())]);
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  const targetLabels = await listDatabaseLabelsByIds(client, [...new Set(targets.map((target) => target.databaseId))]);
  const targetLabelById = new Map(targetLabels.map((label) => [label.id, label]));
  for (const item of items) {
    if (databaseById.get(item.databaseId) !== EVENTS_MODULE_ID) continue;
    const paths = (projectIdsByItem.get(item.id) ?? []).filter((id) => liveProjects.has(id));
    const found = new Map<string, { id: string; title: string }>();
    const contributing = new Set<string>();
    for (const projectId of paths)
      for (const targetId of companyEdges.get(projectId) ?? []) {
        const target = targetsById.get(targetId);
        if (!target) continue;
        const label = targetLabelById.get(target.databaseId);
        if (label?.ownerModuleId !== COMPANIES_MODULE_ID) continue;
        const titleValue = target.properties[label.titlePropertyKey ?? ""];
        found.set(target.id, { id: target.id, title: typeof titleValue === "string" ? titleValue : "" });
        contributing.add(projectId);
      }
    if (found.size)
      result.set(item.id, {
        company: {
          values: [...found.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
          via: "project",
          projectIds: [...contributing].sort(),
        },
      });
  }
  return result;
}
