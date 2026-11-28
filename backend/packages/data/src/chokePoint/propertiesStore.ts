import type { PoolClient } from "pg";
import { NumberFilterConfigSchema, PropertyOptionLabelSchema } from "@semprec/shared";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import {
  ConflictError,
  NotFoundError,
  OptionLabelExistsError,
  PropertyLockedError,
  SchemaLockedError,
  ValidationError,
} from "../errors.js";
import { PROPERTY_TYPES, type DatabaseRow, type PropertyOwner, type PropertyRow, type PropertyType } from "../types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { catalogOptionLabels, type CatalogResolver } from "../manifest/catalogResolution.js";
import { getDatabase } from "./databasesStore.js";

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  return "code" in err && err.code === "23505" && "constraint" in err && err.constraint === constraint;
}

/** `config.options` must be in the `{ key, label? }[]` catalog shape; a bare-string option is refused. */
function assertValidSelectOptions(type: PropertyType, config: Record<string, unknown> | undefined): void {
  if (type !== "select" && type !== "multi_select") return;
  const options = config?.options;
  if (options === undefined) return;
  if (!Array.isArray(options)) {
    throw new ValidationError("select/multi_select config.options must be an array", { field: "config" });
  }
  const elements: unknown[] = options;
  for (const option of elements) {
    if (!isRecord(option)) {
      throw new ValidationError("each select/multi_select option must be an object of shape { key, label? }", {
        field: "config",
      });
    }
    const record: Record<string, unknown> = option;
    const { key, label } = record;
    if (typeof key !== "string" || key.length === 0) {
      throw new ValidationError("each select/multi_select option requires a non-empty string 'key'", {
        field: "config",
      });
    }
    if (label !== undefined && typeof label !== "string") {
      throw new ValidationError("a select/multi_select option's 'label' must be a string when present", {
        field: "config",
      });
    }
    if (Object.hasOwn(record, "color")) {
      if (typeof record.color !== "string" || !/^#[0-9a-f]{6}$/i.test(record.color)) {
        throw new ValidationError("a select/multi_select option's 'color' must be a hex color", { field: "config" });
      }
      record.color = record.color.toUpperCase();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidDefault(type: PropertyType, config: Record<string, unknown> | undefined): void {
  if (!config || !Object.hasOwn(config, "default")) return;
  const value = config.default;
  let valid = false;
  switch (type) {
    case "select":
    case "multi_select":
      valid =
        typeof value === "string" &&
        Array.isArray(config.options) &&
        config.options.some(
          (option: unknown) => typeof option === "object" && option !== null && "key" in option && option.key === value,
        );
      break;
    case "checkbox":
      valid = typeof value === "boolean";
      break;
    case "number":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    case "text":
      valid = typeof value === "string";
      break;
    case "date":
      valid = value === "today" && !config.includeTime;
      break;
  }
  if (!valid) throw new ValidationError("Default does not match the property type or config", { field: "config" });
}

/**
 * A `number` property's `config.filterPresets`/`config.emptyPreset` must match
 * `NumberFilterConfigSchema` (`emptyPreset` needs `filterPresets`); either key on any other type is refused.
 */
function assertValidNumberFilterConfig(type: PropertyType, config: Record<string, unknown> | undefined): void {
  if (!config || (!Object.hasOwn(config, "filterPresets") && !Object.hasOwn(config, "emptyPreset"))) return;
  if (type !== "number") {
    throw new ValidationError("filterPresets and emptyPreset are allowed only on number properties", {
      field: "config",
    });
  }
  const parsed = NumberFilterConfigSchema.safeParse({
    filterPresets: config.filterPresets,
    emptyPreset: config.emptyPreset,
  });
  if (!parsed.success) {
    throw new ValidationError("config.filterPresets/emptyPreset do not match the number filter preset shape", {
      field: "config",
    });
  }
}

export function assertValidPropertyConfig(type: PropertyType, config: Record<string, unknown> | undefined): void {
  assertValidSelectOptions(type, config);
  assertValidDefault(type, config);
  assertValidNumberFilterConfig(type, config);
  if (
    config &&
    Object.hasOwn(config, "format") &&
    (config.format !== "markdown" || (type !== "text" && type !== "longText"))
  ) {
    throw new ValidationError("config.format must be markdown on a text property", { field: "config" });
  }
}

const PROPERTY_OWNERS: readonly PropertyOwner[] = ["user", "system"];
const MIGRATION_STATUSES: readonly PropertyRow["migrationStatus"][] = [
  "stable",
  "pending",
  "running",
  "done",
  "partial",
];

type PropertyDbRow = {
  id: string;
  database_id: string;
  key: string;
  name: string | null;
  type: string;
  config: Record<string, unknown>;
  locked: boolean;
  owner: string;
  owner_process: string | null;
  migration_status: string;
};

function mapPropertyRow(row: PropertyDbRow): PropertyRow {
  return {
    id: row.id,
    databaseId: row.database_id,
    key: row.key,
    name: row.name,
    type: assertKnownValue(PROPERTY_TYPES, row.type, "property type"),
    config: row.config,
    locked: row.locked,
    owner: assertKnownValue(PROPERTY_OWNERS, row.owner, "property owner"),
    ownerProcess: row.owner_process,
    migrationStatus: assertKnownValue(MIGRATION_STATUSES, row.migration_status, "migration status"),
  };
}

const PROPERTY_COLUMNS = "id, database_id, key, name, type, config, locked, owner, owner_process, migration_status";

export async function getProperty(client: PoolClient, propertyId: string): Promise<PropertyRow | null> {
  const { rows } = await client.query<PropertyDbRow>(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = $1`, [
    propertyId,
  ]);
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

/** Holds the schema snapshot until the caller's transaction ends. */
export async function getPropertyForUpdate(client: PoolClient, propertyId: string): Promise<PropertyRow | null> {
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = $1 FOR UPDATE`,
    [propertyId],
  );
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

export async function getPropertyByKey(
  client: PoolClient,
  databaseId: string,
  key: string,
): Promise<PropertyRow | null> {
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 AND key = $2`,
    [databaseId, key],
  );
  return rows[0] ? mapPropertyRow(rows[0]) : null;
}

/** With an optional type filter in the same query. Returns every match; the caller decides what several mean. */
export async function findPropertiesByKey(
  client: PoolClient,
  databaseId: string,
  key: string,
  type?: PropertyType,
): Promise<PropertyRow[]> {
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 AND key = $2 AND ($3::text IS NULL OR type = $3) ORDER BY id`,
    [databaseId, key, type ?? null],
  );
  return rows.map(mapPropertyRow);
}

/** Those of `propertyIds` readable in the caller's tenant scope. */
export async function listPropertiesByIds(client: PoolClient, propertyIds: readonly string[]): Promise<PropertyRow[]> {
  if (propertyIds.length === 0) return [];
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [propertyIds],
  );
  return rows.map(mapPropertyRow);
}

export async function listPropertiesByDatabase(client: PoolClient, databaseId: string): Promise<PropertyRow[]> {
  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = $1 ORDER BY initial_position ASC NULLS LAST, key`,
    [databaseId],
  );
  return rows.map(mapPropertyRow);
}

/** One query for many databases; a database with no properties is absent from the map. */
export async function listPropertiesByDatabases(
  client: PoolClient,
  databaseIds: readonly string[],
): Promise<Map<string, PropertyRow[]>> {
  const grouped = new Map<string, PropertyRow[]>();
  if (databaseIds.length === 0) return grouped;

  const { rows } = await client.query<PropertyDbRow>(
    `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE database_id = ANY($1) ORDER BY database_id, initial_position ASC NULLS LAST, key`,
    [databaseIds],
  );
  for (const row of rows) {
    const property = mapPropertyRow(row);
    const existing = grouped.get(property.databaseId);
    if (existing) {
      existing.push(property);
    } else {
      grouped.set(property.databaseId, [property]);
    }
  }
  return grouped;
}

async function requireProperty(client: PoolClient, propertyId: string): Promise<PropertyRow> {
  const property = await getProperty(client, propertyId);
  if (!property) throw new NotFoundError(`Property ${propertyId} not found`);
  return property;
}

async function requirePropertyForUpdate(client: PoolClient, propertyId: string): Promise<PropertyRow> {
  const property = await getPropertyForUpdate(client, propertyId);
  if (!property) throw new NotFoundError(`Property ${propertyId} not found`);
  return property;
}

async function assertDatabaseSchemaUnlocked(client: PoolClient, databaseId: string): Promise<DatabaseRow> {
  const database = await getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (database.schemaLocked) {
    throw new SchemaLockedError("The owning database's schema is locked; only a code-level migration may change it");
  }
  return database;
}

export interface CreatePropertyInput {
  databaseId: string;
  key: string;
  /** Required unless the owning database is a system database (enforced below, not by the column). */
  name: string | null;
  type: PropertyType;
  config?: Record<string, unknown>;
  locked?: boolean;
  owner?: PropertyOwner;
  ownerProcess?: string;
}

export async function createProperty(client: PoolClient, input: CreatePropertyInput): Promise<PropertyRow> {
  if (!PROPERTY_TYPES.includes(input.type)) {
    throw new ValidationError(`Unknown property type '${input.type}'`, { field: "type" });
  }
  const database = await assertDatabaseSchemaUnlocked(client, input.databaseId);
  if (!database.system && !input.name) {
    throw new ValidationError("name is required for a property of a non-system database", { field: "name" });
  }
  assertValidPropertyConfig(input.type, input.config);

  try {
    const { rows } = await client.query<PropertyDbRow>(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING ${PROPERTY_COLUMNS}`,
      [
        input.databaseId,
        input.key,
        input.name,
        input.type,
        JSON.stringify(input.config ?? {}),
        input.locked ?? false,
        input.owner ?? "user",
        input.ownerProcess ?? null,
      ],
    );
    return mapPropertyRow(requireSingleRow(rows, "properties row"));
  } catch (err) {
    if (isUniqueViolation(err, "properties_database_id_key_key")) {
      throw new ConflictError(`Property key '${input.key}' already exists in database ${input.databaseId}`, {
        field: "key",
        reason: "duplicate",
      });
    }
    throw err;
  }
}

/** Records the initial cohort position inside the collection-creation transaction. */
export async function setInitialPosition(
  client: PoolClient,
  databaseId: string,
  propertyId: string,
  position: number,
): Promise<void> {
  const result = await client.query("UPDATE properties SET initial_position = $3 WHERE database_id = $1 AND id = $2", [
    databaseId,
    propertyId,
    position,
  ]);
  requireAffectedRows(result, "initial property position update");
}

/** `locked` governs deletion and type change, never the display name. */
export async function renameProperty(client: PoolClient, propertyId: string, name: string): Promise<PropertyRow> {
  await requireProperty(client, propertyId);
  const { rows } = await client.query<PropertyDbRow>(
    `UPDATE properties SET name = $2 WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, name],
  );
  return mapPropertyRow(requireSingleRow(rows, "properties row"));
}

async function assertPropertySchemaMutable(client: PoolClient, property: PropertyRow): Promise<void> {
  if (property.locked) {
    throw new PropertyLockedError(`Property ${property.id} is locked; its schema cannot be changed`);
  }
  await assertDatabaseSchemaUnlocked(client, property.databaseId);
}

/**
 * Changes the type and optional config together, validating the pair under the row lock. The caller
 * checks mirror dependencies and conversion paths.
 */
export async function changePropertyType(
  client: PoolClient,
  propertyId: string,
  newType: PropertyType,
  migrationStatus: PropertyRow["migrationStatus"],
  config?: Record<string, unknown>,
): Promise<PropertyRow> {
  if (!PROPERTY_TYPES.includes(newType)) {
    throw new ValidationError(`Unknown property type '${newType}'`, { field: "type" });
  }
  const property = await requirePropertyForUpdate(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  const finalConfig = config ?? property.config;
  assertValidPropertyConfig(newType, finalConfig);

  // `migration_dropped_values` is cleared only here: a fresh retype starts a new migration. Every
  // other writer only sets the flag.
  const result = await client.query<PropertyDbRow>(
    `UPDATE properties SET type = $2, migration_status = $3, migration_dropped_values = false, config = $4::jsonb
     WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, newType, migrationStatus, JSON.stringify(finalConfig)],
  );
  requireAffectedRows(result, "properties row");
  return mapPropertyRow(requireSingleRow(result.rows, "properties row"));
}

export async function setPropertyMigrationStatus(
  client: PoolClient,
  propertyId: string,
  migrationStatus: PropertyRow["migrationStatus"],
): Promise<void> {
  await client.query(`UPDATE properties SET migration_status = $2 WHERE id = $1`, [propertyId, migrationStatus]);
}

/**
 * Idempotent and never reset here: the fact belongs to the retype, and a retried or overlapping run
 * skips values an earlier run dropped, so it could not record them again.
 */
export async function markPropertyMigrationDroppedValues(client: PoolClient, propertyId: string): Promise<void> {
  await client.query(`UPDATE properties SET migration_dropped_values = true WHERE id = $1`, [propertyId]);
}

/**
 * Settles on 'partial' or 'done' from the durable `migration_dropped_values` flag, so a retry or an
 * overlapping run cannot downgrade an earlier 'partial' to 'done'.
 */
export async function settlePropertyMigrationStatus(client: PoolClient, propertyId: string): Promise<void> {
  await client.query(
    `UPDATE properties
     SET migration_status = CASE WHEN migration_dropped_values THEN 'partial' ELSE 'done' END
     WHERE id = $1`,
    [propertyId],
  );
}

export async function setPropertyLocked(client: PoolClient, propertyId: string, locked: boolean): Promise<void> {
  await client.query(`UPDATE properties SET locked = $2 WHERE id = $1`, [propertyId, locked]);
}

export async function updatePropertyConfig(
  client: PoolClient,
  propertyId: string,
  config: Record<string, unknown>,
): Promise<PropertyRow> {
  const property = await requirePropertyForUpdate(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  assertValidPropertyConfig(property.type, config);

  const { rows } = await client.query<PropertyDbRow>(
    `UPDATE properties SET config = $2::jsonb WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [propertyId, JSON.stringify(config)],
  );
  return mapPropertyRow(requireSingleRow(rows, "properties row"));
}

/** The caller checks mirror dependencies first. */
export async function deleteProperty(client: PoolClient, propertyId: string): Promise<void> {
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
}

/**
 * Deletes properties of kept databases whose relation partner or rollup source is being purged. The
 * schema-lock check is skipped: the relation's other side no longer exists. Relation definitions and
 * rollup dependencies go by foreign key. Ids already removed concurrently are skipped; returns the
 * deleted ids.
 */
export async function deletePropertiesOfPurgedDatabase(
  client: PoolClient,
  propertyIds: readonly string[],
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    "DELETE FROM properties WHERE id = ANY($1::uuid[]) RETURNING id",
    [propertyIds],
  );
  return rows.map((row) => row.id);
}

const PROPERTY_OPTION_LIMIT = 100;

/** An element of `config.options` that `assertValidSelectOptions` accepts. */
type StoredOption = Record<string, unknown> & { key: string; label?: string };

function isStoredOption(value: unknown): value is StoredOption {
  return (
    isRecord(value) && typeof value.key === "string" && (value.label === undefined || typeof value.label === "string")
  );
}

export interface PropertyOptionWrite {
  property: PropertyRow;
  database: DatabaseRow;
  optionKey: string;
}

/**
 * Locks the property row until the caller's transaction ends and returns it with its database and
 * stored options. Refuses an unknown, non-select, or `locked` property and invalid stored options.
 * The database's `schema_locked` is deliberately not checked
 * (docs/architecture/data-model-and-writes.md#properties).
 */
async function lockPropertyForOptionWrite(
  client: PoolClient,
  propertyId: string,
): Promise<{ property: PropertyRow; database: DatabaseRow; options: StoredOption[] }> {
  const property = await requirePropertyForUpdate(client, propertyId);
  if (property.type !== "select" && property.type !== "multi_select") {
    throw new ValidationError(`Property ${propertyId} is not a select or multi_select property`, {
      field: "propertyId",
    });
  }
  if (property.locked) {
    throw new PropertyLockedError(`Property ${property.id} is locked; its schema cannot be changed`);
  }
  const database = await getDatabase(client, property.databaseId);
  if (!database) throw new NotFoundError(`Database ${property.databaseId} not found`);
  assertValidSelectOptions(property.type, property.config);
  const stored: unknown[] = Array.isArray(property.config.options) ? property.config.options : [];
  // The elements were validated just above; the guard only narrows the type.
  return { property, database, options: stored.filter(isStoredOption) };
}

/**
 * Trimmed, 1 to 60 UTF-16 code units. U+0000 and lone surrogates are refused here because `jsonb`
 * cannot hold them and the `UPDATE` would fail with a database error instead.
 */
function parseOptionLabel(label: string): string {
  const parsed = PropertyOptionLabelSchema.safeParse(label);
  if (!parsed.success) {
    throw new ValidationError(
      "An option label must have 1 to 60 characters and hold neither U+0000 nor a surrogate without its pair",
      { field: "label" },
    );
  }
  return parsed.data;
}

/** Without diacritics, surrounding whitespace and letter case. */
export function foldLabel(label: string): string {
  return label.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

/**
 * Refuses `label` when another option has it as stored label or as the Czech or English catalog
 * label of its key, compared via `foldLabel`. A bare key shown for an unlabelled option is not compared.
 */
async function assertOptionLabelFree(
  label: string,
  others: readonly StoredOption[],
  property: PropertyRow,
  database: DatabaseRow,
  catalogResolver: Pick<CatalogResolver, "getCatalogsForDbKey">,
): Promise<void> {
  const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
  const wanted = foldLabel(label);
  const existing = others.find((option) =>
    [option.label, ...catalogOptionLabels(catalogs, database.key, property.key, option.key)].some(
      (shown) => shown !== undefined && foldLabel(shown) === wanted,
    ),
  );
  if (existing) {
    throw new OptionLabelExistsError(`Property ${property.id} already has an option with this label`, {
      key: existing.key,
    });
  }
}

/**
 * For a caller that holds the row and writes nothing. Read without a lock, so a concurrent add is not
 * seen; `addPropertyOption` checks again on the locked row.
 */
export async function assertPropertyOptionLabelFree(
  label: string,
  property: PropertyRow,
  database: DatabaseRow,
  catalogResolver: Pick<CatalogResolver, "getCatalogsForDbKey">,
): Promise<void> {
  const stored: unknown[] = Array.isArray(property.config.options) ? property.config.options : [];
  await assertOptionLabelFree(label, stored.filter(isStoredOption), property, database, catalogResolver);
}

/**
 * The label's words in ASCII camelCase (diacritics removed, other non-alphanumerics separate words),
 * `option` when none. A taken key gets the lowest free numeric suffix from 2.
 */
function newOptionKey(label: string, options: readonly StoredOption[]): string {
  const words = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
  const camelCase = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");
  const base = camelCase.length > 0 ? camelCase : "option";
  const taken = new Set(options.map((option) => option.key));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

/**
 * Locks, `FOR SHARE` and in id order, the `select`/`multi_select` properties of `databaseId` among `keys`, so a
 * caller that validates item values against their options reads them after this statement and holds them until
 * commit: `removePropertyOption`'s `FOR UPDATE` waits for the caller, or the caller waits and reads the options
 * without the removed one.
 */
export async function lockChoicePropertiesForShare(
  client: PoolClient,
  databaseId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await client.query<{ id: string }>(
    `SELECT id FROM properties
      WHERE database_id = $1 AND key = ANY($2::text[]) AND type IN ('select', 'multi_select')
      ORDER BY id FOR SHARE`,
    [databaseId, keys],
  );
}

/** After the same config validation every config write runs. */
async function writePropertyOptions(
  client: PoolClient,
  property: PropertyRow,
  options: readonly StoredOption[],
): Promise<PropertyRow> {
  const config = { ...property.config, options };
  assertValidPropertyConfig(property.type, config);
  const result = await client.query<PropertyDbRow>(
    `UPDATE properties SET config = $2::jsonb WHERE id = $1 RETURNING ${PROPERTY_COLUMNS}`,
    [property.id, JSON.stringify(config)],
  );
  requireAffectedRows(result, "properties option write");
  return mapPropertyRow(requireSingleRow(result.rows, "properties row"));
}

/**
 * Appends one option, also on a schema-locked database; the key comes from `newOptionKey`. Refuses a
 * duplicate label (`OptionLabelExistsError` with that option's key), an invalid label and a property
 * already at the limit. The row lock until commit makes concurrent adds both end up stored.
 */
export async function addPropertyOption(
  client: PoolClient,
  propertyId: string,
  input: { label: string; color?: string },
  catalogResolver: Pick<CatalogResolver, "getCatalogsForDbKey">,
): Promise<PropertyOptionWrite> {
  const { property, database, options } = await lockPropertyForOptionWrite(client, propertyId);
  const label = parseOptionLabel(input.label);
  if (options.length >= PROPERTY_OPTION_LIMIT) {
    throw new ValidationError(`A property holds at most ${PROPERTY_OPTION_LIMIT} options`, {
      reason: "option_limit",
    });
  }
  await assertOptionLabelFree(label, options, property, database, catalogResolver);
  const optionKey = newOptionKey(label, options);
  const option: StoredOption = { key: optionKey, label, ...(input.color !== undefined ? { color: input.color } : {}) };
  const updated = await writePropertyOptions(client, property, [...options, option]);
  return { property: updated, database, optionKey };
}

/**
 * Writes the label, color or both of one option, also on a schema-locked database; key and position
 * stay. Refuses an unknown key, an empty patch, an invalid label and a duplicate label.
 */
export async function updatePropertyOption(
  client: PoolClient,
  propertyId: string,
  optionKey: string,
  patch: { label?: string; color?: string },
  catalogResolver: Pick<CatalogResolver, "getCatalogsForDbKey">,
): Promise<PropertyOptionWrite> {
  const { property, database, options } = await lockPropertyForOptionWrite(client, propertyId);
  const current = options.find((option) => option.key === optionKey);
  if (!current) {
    throw new NotFoundError(`Property ${propertyId} has no option with the given key`, {
      resource: "propertyOption",
      propertyId,
      key: optionKey,
    });
  }
  if (patch.label === undefined && patch.color === undefined) {
    throw new ValidationError("Patch must include at least one field", { reason: "empty_patch" });
  }
  const next: StoredOption = { ...current };
  if (patch.label !== undefined) {
    const label = parseOptionLabel(patch.label);
    const others = options.filter((option) => option !== current);
    await assertOptionLabelFree(label, others, property, database, catalogResolver);
    next.label = label;
  }
  if (patch.color !== undefined) next.color = patch.color;
  const updated = await writePropertyOptions(
    client,
    property,
    options.map((option) => (option === current ? next : option)),
  );
  return { property: updated, database, optionKey };
}

/**
 * Removes one option, also on a schema-locked database, and a `config.default` naming it. Refuses an unknown key, and a
 * system-owned property with `validation_failed` (`reason: "system_owned"`). The property row stays locked until
 * the caller's transaction ends, so the caller clears the key from item values before another option write or an item
 * write checked against the options (`lockChoicePropertiesForShare`) can proceed.
 */
export async function removePropertyOption(
  client: PoolClient,
  propertyId: string,
  optionKey: string,
): Promise<{ property: PropertyRow; database: DatabaseRow }> {
  const { property, database, options } = await lockPropertyForOptionWrite(client, propertyId);
  if (property.owner === "system") {
    throw new ValidationError(`Property ${propertyId} is owned by 'system'; its options cannot be removed`, {
      field: "propertyId",
      reason: "system_owned",
    });
  }
  if (!options.some((option) => option.key === optionKey)) {
    throw new NotFoundError(`Property ${propertyId} has no option with the given key`, {
      resource: "propertyOption",
      propertyId,
      key: optionKey,
    });
  }
  const remaining = options.filter((option) => option.key !== optionKey);
  const { default: storedDefault, ...rest } = property.config;
  const config = storedDefault === optionKey ? rest : property.config;
  const updated = await writePropertyOptions(client, { ...property, config }, remaining);
  return { property: updated, database };
}
