// An item's area is derived from its project. When an item that has its own area edge gets a project, the own edge
// is removed in the same transaction, by the same writer, so only the project's area is left.
import { z } from "zod";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { listRelationEdgesForItemOnDefinitions, otherSide } from "../chokePoint/relationsStore.js";
import { GUARDED_DERIVED_VALUE_SOURCES } from "./derivedValueSources.js";

const AREA_SOURCES = GUARDED_DERIVED_VALUE_SOURCES.filter((source) => source.propertyKey === "area");

const ATTACHMENT_ROW = z.object({
  item_is_a: z.boolean(),
  area_property_id: z.string(),
  area_definition_id: z.string(),
});

export const projectAttachmentAreaEdgeChangedHook: RelationEdgeChangedHook = async ({
  client,
  op,
  relationDefinitionId,
  itemA,
  itemB,
  writer,
}) => {
  if (op !== "create") return;
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT rd.property_id_a = p.id AS item_is_a, area.id AS area_property_id, area_rd.id AS area_definition_id
     FROM relation_definitions rd
     JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
     JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system
     JOIN properties area ON area.tenant_id = p.tenant_id AND area.database_id = d.id AND area.key = 'area'
       AND area.type = 'relation'
     JOIN relation_definitions area_rd ON area_rd.tenant_id = area.tenant_id
       AND area.id IN (area_rd.property_id_a, area_rd.property_id_b)
     WHERE rd.tenant_id = app_tenant_default() AND rd.id = $1 AND p.type = 'relation'
       AND (d.owner_module_id, p.key) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [
      relationDefinitionId,
      AREA_SOURCES.map((source) => source.databaseKey),
      AREA_SOURCES.map((source) => source.projectPropertyKey),
    ],
  );
  const row = rows[0];
  if (row === undefined) return;
  const attachment = ATTACHMENT_ROW.parse(row);
  const itemId = attachment.item_is_a ? itemA : itemB;
  const ownEdges = await listRelationEdgesForItemOnDefinitions(client, [attachment.area_definition_id], itemId);
  for (const edge of ownEdges) {
    await deleteRelationWithClient(
      client,
      { relationPropertyId: attachment.area_property_id, callerItemId: itemId, targetItemId: otherSide(edge, itemId) },
      undefined,
      writer,
    );
  }
};
