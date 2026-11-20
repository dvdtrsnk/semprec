import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { assertValidPropertyConfig } from "../chokePoint/propertiesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { PROPERTY_TYPES, type PropertyOwner, type PropertyType, type RelationDefinitionRow } from "../types.js";
import { lockTenantSeedInTransaction, readFreshSystemSeed } from "./seedSystem.js";

interface SystemProperty {
  id: string;
  databaseModuleId: string;
  key: string;
  name: string | null;
  type: PropertyType;
  config: Record<string, unknown>;
  locked: boolean;
  owner: PropertyOwner;
  ownerProcess: string | null;
  initialPosition: number | null;
}

interface SystemRelation {
  id: string;
  propertyIdA: string;
  propertyIdB: string | null;
  cardinality: RelationDefinitionRow["cardinality"];
}

/** The property and relation definitions of a tenant's system databases, which are keyed by their owner module. */
export interface SystemDefinitions {
  databases: ReadonlyMap<string, string>;
  properties: readonly SystemProperty[];
  relations: readonly SystemRelation[];
}

/**
 * - `missingDatabase`: the seed creates the system database, the tenant has none, so nothing is added to it.
 * - `type`, `owner`: the property exists with another type or owner (or owner process).
 * - `config`: the property exists with another config; a select's missing options (appended) and option order aside.
 * - `relation`: the relation exists with other sides or another cardinality, or only one of its sides exists.
 * - `unmappable`: the definition refers to something the tenant lacks and the reconcile does not create.
 */
export type SeedConflictTag = "missingDatabase" | "type" | "owner" | "config" | "relation" | "unmappable";

export interface SeedConflict {
  tag: SeedConflictTag;
  /** The owner module of the system database. */
  database: string;
  /** `null` for `missingDatabase`. */
  key: string | null;
}

/** Options the seed defines that were appended to an existing select or multi-select property. */
export interface SeedAppendedOptions {
  /** The owner module of the system database. */
  database: string;
  key: string;
  /** The appended option keys, in the seed's order. */
  options: string[];
}

export interface SeedReconcileReport {
  createdProperties: number;
  createdRelationDefinitions: number;
  appendedOptions: SeedAppendedOptions[];
  conflicts: SeedConflict[];
}

const PROPERTY_OWNERS: readonly PropertyOwner[] = ["user", "system"];
const CARDINALITIES: readonly RelationDefinitionRow["cardinality"][] = ["one_to_one", "one_to_many", "many_to_many"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Malformed ${label} in database row`);
  return value;
}

async function readSystemDefinitions(client: PoolClient): Promise<SystemDefinitions> {
  const databases = await client.query<{ id: string; owner_module_id: string }>(
    "SELECT id, owner_module_id FROM databases WHERE system AND owner_module_id IS NOT NULL",
  );
  const properties = await client.query<{
    id: string;
    owner_module_id: string;
    key: string;
    name: string | null;
    type: string;
    config: unknown;
    locked: boolean;
    owner: string;
    owner_process: string | null;
    initial_position: number | null;
  }>(
    `SELECT p.id, d.owner_module_id, p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process,
            p.initial_position
       FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE d.system AND d.owner_module_id IS NOT NULL`,
  );
  const relations = await client.query<{
    id: string;
    property_id_a: string;
    property_id_b: string | null;
    cardinality: string;
  }>(
    `SELECT r.id, r.property_id_a, r.property_id_b, r.cardinality
       FROM relation_definitions r
      WHERE EXISTS (
        SELECT 1 FROM properties p JOIN databases d ON d.id = p.database_id
         WHERE d.system AND d.owner_module_id IS NOT NULL AND p.id IN (r.property_id_a, r.property_id_b))`,
  );
  return {
    databases: new Map(databases.rows.map((row) => [row.owner_module_id, row.id])),
    properties: properties.rows.map((row) => ({
      id: row.id,
      databaseModuleId: row.owner_module_id,
      key: row.key,
      name: row.name,
      type: assertKnownValue(PROPERTY_TYPES, row.type, "property type"),
      config: requireRecord(row.config, "properties.config"),
      locked: row.locked,
      owner: assertKnownValue(PROPERTY_OWNERS, row.owner, "property owner"),
      ownerProcess: row.owner_process,
      initialPosition: row.initial_position,
    })),
    relations: relations.rows.map((row) => ({
      id: row.id,
      propertyIdA: row.property_id_a,
      propertyIdB: row.property_id_b,
      cardinality: assertKnownValue(CARDINALITIES, row.cardinality, "cardinality"),
    })),
  };
}

/** What a freshly seeded tenant holds, read from a seed that is rolled back. Runs outside any tenant scope. */
export function readSeedDefinitions(pool: Pool): Promise<SystemDefinitions> {
  return readFreshSystemSeed(pool, readSystemDefinitions);
}

/**
 * Replaces every reference id (database, property, relation definition) in a config by the tenant's id. Any other
 * UUID-shaped string, as a value or a key, makes the config unmappable: it names something of the reference tenant.
 */
function mapConfigIds(
  config: Record<string, unknown>,
  ids: ReadonlyMap<string, string>,
): { config: Record<string, unknown>; unmapped: boolean } {
  let unmapped = false;
  const mapString = (text: string): string => {
    const mapped = ids.get(text);
    if (mapped !== undefined) return mapped;
    if (UUID_PATTERN.test(text)) unmapped = true;
    return text;
  };
  const mapRecord = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).map(([key, child]) => [mapString(key), walk(child)]));
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return mapString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) return mapRecord(node);
    return node;
  };
  const mapped = mapRecord(config);
  return { config: mapped, unmapped };
}

interface PlannedProperty {
  id: string;
  databaseId: string;
  reference: SystemProperty;
}

interface PlannedRelation {
  id: string;
  propertyIdA: string;
  propertyIdB: string | null;
  cardinality: SystemRelation["cardinality"];
}

interface PlannedOptionAppend extends SeedAppendedOptions {
  propertyId: string;
  type: PropertyType;
  config: Record<string, unknown>;
}

interface Plan {
  properties: Array<PlannedProperty & { config: Record<string, unknown> }>;
  relations: PlannedRelation[];
  optionAppends: PlannedOptionAppend[];
  conflicts: SeedConflict[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type SelectOption = Record<string, unknown> & { key: string };

function selectOptions(config: Record<string, unknown>): SelectOption[] | null {
  const { options } = config;
  if (!Array.isArray(options)) return null;
  const elements: unknown[] = options;
  const parsed: SelectOption[] = [];
  for (const option of elements) {
    if (!isRecord(option) || typeof option.key !== "string") return null;
    parsed.push({ ...option, key: option.key });
  }
  return parsed;
}

/**
 * Compares a tenant's select config with the seed's, option order aside. `missing`: the seed's options the tenant
 * lacks, in the seed's order; `appendable` when nothing else differs except options the seed does not define (`extra`).
 */
function compareSelectConfig(
  reference: Record<string, unknown>,
  target: Record<string, unknown>,
): { appendable: boolean; missing: SelectOption[]; extra: boolean; targetOptions: SelectOption[] } | null {
  const referenceOptions = selectOptions(reference);
  const targetOptions = selectOptions(target);
  if (referenceOptions === null || targetOptions === null) return null;
  const { options: _referenceOptions, ...referenceRest } = reference;
  const { options: _targetOptions, ...targetRest } = target;
  const targetByKey = new Map(targetOptions.map((option) => [option.key, option]));
  const referenceKeys = new Set(referenceOptions.map((option) => option.key));
  const sameExisting = referenceOptions.every((option) => {
    const existing = targetByKey.get(option.key);
    return existing === undefined || isDeepStrictEqual(existing, option);
  });
  return {
    appendable: sameExisting && isDeepStrictEqual(referenceRest, targetRest),
    missing: referenceOptions.filter((option) => !targetByKey.has(option.key)),
    extra: targetOptions.some((option) => !referenceKeys.has(option.key)),
    targetOptions,
  };
}

function definitionKey(databaseModuleId: string, key: string): string {
  return `${databaseModuleId}\u0000${key}`;
}

/**
 * Decides, without writing, which reference definitions the tenant lacks and can receive as they are, and which
 * existing ones differ. A relation is created only when every side of it is missing; nothing existing is changed.
 */
function planReconcile(reference: SystemDefinitions, target: SystemDefinitions): Plan {
  const conflicts: SeedConflict[] = [];
  const ids = new Map<string, string>();
  for (const [moduleId, referenceId] of reference.databases) {
    const targetId = target.databases.get(moduleId);
    if (targetId === undefined) conflicts.push({ tag: "missingDatabase", database: moduleId, key: null });
    else ids.set(referenceId, targetId);
  }

  const targetProperties = new Map(target.properties.map((p) => [definitionKey(p.databaseModuleId, p.key), p]));
  const planned = new Map<string, PlannedProperty>();
  const existing: Array<{ reference: SystemProperty; target: SystemProperty }> = [];
  for (const property of reference.properties) {
    const databaseId = target.databases.get(property.databaseModuleId);
    if (databaseId === undefined) continue;
    const match = targetProperties.get(definitionKey(property.databaseModuleId, property.key));
    if (match) {
      ids.set(property.id, match.id);
      existing.push({ reference: property, target: match });
    } else {
      const id = randomUUID();
      ids.set(property.id, id);
      planned.set(property.id, { id, databaseId, reference: property });
    }
  }

  const referenceById = new Map(reference.properties.map((p) => [p.id, p]));
  const targetRelationBySideA = new Map(target.relations.map((r) => [r.propertyIdA, r]));
  const plannedRelations = new Map<string, PlannedRelation>();
  const relationBySide = new Map<string, SystemRelation>();
  const drop = (referencePropertyId: string, tag: SeedConflictTag): void => {
    const property = planned.get(referencePropertyId);
    if (!property) return;
    planned.delete(referencePropertyId);
    ids.delete(referencePropertyId);
    conflicts.push({ tag, database: property.reference.databaseModuleId, key: property.reference.key });
    const relation = relationBySide.get(referencePropertyId);
    if (relation && plannedRelations.delete(relation.id)) {
      ids.delete(relation.id);
      drop(relation.propertyIdA, tag);
      if (relation.propertyIdB !== null) drop(relation.propertyIdB, tag);
    }
  };

  for (const relation of reference.relations) {
    const sides = relation.propertyIdB === null ? [relation.propertyIdA] : [relation.propertyIdA, relation.propertyIdB];
    const plannedA = planned.get(relation.propertyIdA);
    const plannedB = relation.propertyIdB === null ? null : planned.get(relation.propertyIdB);
    if (plannedA && plannedB !== undefined) {
      const id = randomUUID();
      ids.set(relation.id, id);
      plannedRelations.set(relation.id, {
        id,
        propertyIdA: plannedA.id,
        propertyIdB: plannedB?.id ?? null,
        cardinality: relation.cardinality,
      });
      for (const side of sides) relationBySide.set(side, relation);
      continue;
    }
    const plannedSides = sides.filter((side) => planned.has(side));
    if (plannedSides.length > 0) {
      for (const side of plannedSides) drop(side, "relation");
      continue;
    }
    const targetA = ids.get(relation.propertyIdA);
    const targetB = relation.propertyIdB === null ? null : ids.get(relation.propertyIdB);
    if (targetA === undefined || targetB === undefined) continue;
    const match = targetRelationBySideA.get(targetA);
    // Same sides: the sides' configs name this definition, so they compare equal even when the cardinality differs.
    const sameSides = match !== undefined && match.propertyIdB === targetB;
    if (sameSides) ids.set(relation.id, match.id);
    if (!sameSides || match.cardinality !== relation.cardinality) {
      const sideA = referenceById.get(relation.propertyIdA);
      if (sideA) conflicts.push({ tag: "relation", database: sideA.databaseModuleId, key: sideA.key });
    }
  }

  // Dropping a property removes its id from the map, which can make another planned config unmappable.
  for (let changed = true; changed;) {
    changed = false;
    for (const [referenceId, property] of planned) {
      if (mapConfigIds(property.reference.config, ids).unmapped) {
        drop(referenceId, "unmappable");
        changed = true;
      }
    }
  }

  const optionAppends: PlannedOptionAppend[] = [];
  for (const { reference: property, target: match } of existing) {
    const conflict = (tag: SeedConflictTag) =>
      conflicts.push({ tag, database: property.databaseModuleId, key: property.key });
    if (property.type !== match.type) conflict("type");
    if (property.owner !== match.owner || property.ownerProcess !== match.ownerProcess) conflict("owner");
    const config = mapConfigIds(property.config, ids).config;
    if (isDeepStrictEqual(config, match.config)) continue;
    const select =
      property.type === match.type && (match.type === "select" || match.type === "multi_select")
        ? compareSelectConfig(config, match.config)
        : null;
    if (select?.appendable !== true) {
      conflict("config");
      continue;
    }
    if (select.extra) conflict("config");
    if (select.missing.length === 0) continue;
    optionAppends.push({
      propertyId: match.id,
      database: property.databaseModuleId,
      key: property.key,
      type: match.type,
      config: { ...match.config, options: [...select.targetOptions, ...select.missing] },
      options: select.missing.map((option) => option.key),
    });
  }
  optionAppends.sort((a, b) => compareText(a.database, b.database) || compareText(a.key, b.key));

  conflicts.sort(
    (a, b) => compareText(a.database, b.database) || compareText(a.key ?? "", b.key ?? "") || compareText(a.tag, b.tag),
  );
  return {
    properties: [...planned.values()].map((property) => ({
      ...property,
      config: mapConfigIds(property.reference.config, ids).config,
    })),
    relations: [...plannedRelations.values()],
    optionAppends,
    conflicts,
  };
}

/**
 * Creates, in the caller's tenant, every system property and relation definition of `reference` the tenant lacks,
 * with the reference's definition and ids mapped to the tenant's, and appends to an existing select or multi-select
 * property the options of `reference` it lacks, after its own options. Nothing else of an existing definition is
 * changed; one that differs otherwise is reported. One transaction under the seed's per-tenant lock; locked schemas
 * are written with raw SQL under an exclusive `properties` lock, as the seed does.
 */
export async function reconcileSeedDefinitions(pool: Pool, reference: SystemDefinitions): Promise<SeedReconcileReport> {
  return withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "reconcileSeedDefinitions");
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const plan = planReconcile(reference, await readSystemDefinitions(client));
    for (const property of plan.properties) {
      const { reference: definition } = property;
      assertValidPropertyConfig(definition.type, property.config);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO properties (id, database_id, key, name, type, config, locked, owner, owner_process, initial_position)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         RETURNING id`,
        [
          property.id,
          property.databaseId,
          definition.key,
          definition.name,
          definition.type,
          JSON.stringify(property.config),
          definition.locked,
          definition.owner,
          definition.ownerProcess,
          definition.initialPosition,
        ],
      );
      requireSingleRow(rows, "reconciled properties row");
    }
    for (const relation of plan.relations) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO relation_definitions (id, property_id_a, property_id_b, cardinality)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [relation.id, relation.propertyIdA, relation.propertyIdB, relation.cardinality],
      );
      requireSingleRow(rows, "reconciled relation_definitions row");
    }
    for (const append of plan.optionAppends) {
      assertValidPropertyConfig(append.type, append.config);
      const result = await client.query("UPDATE properties SET config = $2::jsonb WHERE id = $1", [
        append.propertyId,
        JSON.stringify(append.config),
      ]);
      requireAffectedRows(result, "reconciled select options");
    }
    return {
      createdProperties: plan.properties.length,
      createdRelationDefinitions: plan.relations.length,
      appendedOptions: plan.optionAppends.map(({ database, key, options }) => ({ database, key, options })),
      conflicts: plan.conflicts,
    };
  });
}
