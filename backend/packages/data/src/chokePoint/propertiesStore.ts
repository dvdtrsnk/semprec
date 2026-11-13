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

/** True when a Postgres error is the named unique-index violation, so callers can turn it into a clean ConflictError. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  return "code" in err && err.code === "23505" && "constraint" in err && err.constraint === constraint;
}

/**
 * Issue #145: a select/multi_select property's `config.options` must already be in the
 * `{ key, label? }[]` catalog shape — the bare-string shape only ever exists in already-
 * written rows, repaired once by migration 0029, never accepted from a new write.
 */
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

/** Validates the optional create-time default against the property's storage type. */
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
 * Issue #1622: a `number` property's `config.filterPresets` / `config.emptyPreset` must match the shared
 * `NumberFilterConfigSchema`; `emptyPreset` without `filterPresets` fails it. Either key on any other type is
 * refused. Other config keys are not looked at here.
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

/** The raw `properties` row shape this module reads back from Postgres. */
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

/**
 * Issue #432: the `(database_id, key)` lookup `UNIQUE(database_id, key)` indexes, with an optional
 * type filter applied in the same query. Returns every matching row rather than the first, so the
 * caller — not this query — decides what more than one match means.
 */
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

/** The batch form of `getProperty`: the properties among `propertyIds` that the caller's tenant scope can read. */
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

/**
 * Batch form of `listPropertiesByDatabase` for callers iterating many databases at once (issue
 * #147's system-wide schema projection) — one query instead of one-per-database, grouped by
 * `databaseId` in memory. A database with no properties is simply absent from the result map.
 */
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
  /** Required unless the owning database is a system database — enforced below, not by the (now nullable) column. */
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

/** The label is always renamable — `locked` governs deletion / type change, never the display name. */
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

/** Changes the type and optional replacement config together, validating the final pair under the row lock.
 * Caller (the choke-point) is responsible for the mirror-dependency and conversion-path checks.
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

  // `migration_dropped_values` is cleared here and only here: a fresh retype starts a new
  // migration, so whatever a previous retype of this property discarded is no longer its
  // result. Every other writer only ever sets the flag.
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
 * Records that a property-type migration discarded an unconvertible value. Idempotent, and
 * deliberately not reset here — see migration 0026 for why this outlives a single job run.
 */
export async function markPropertyMigrationDroppedValues(client: PoolClient, propertyId: string): Promise<void> {
  await client.query(`UPDATE properties SET migration_dropped_values = true WHERE id = $1`, [propertyId]);
}

/**
 * Settles a finished property-type migration on 'partial' or 'done' from the durable
 * `migration_dropped_values` flag rather than from the calling run's own bookkeeping, so
 * a retry or an overlapping run cannot downgrade an earlier run's 'partial' to 'done'.
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

/** Caller (the choke-point) is responsible for the mirror-dependency check before calling this. */
export async function deleteProperty(client: PoolClient, propertyId: string): Promise<void> {
  const property = await requireProperty(client, propertyId);
  await assertPropertySchemaMutable(client, property);
  await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
}

/** The most options `addPropertyOption` lets one property hold. */
const PROPERTY_OPTION_LIMIT = 100;

/** One element of a stored `config.options` array that `assertValidSelectOptions` accepts. */
type StoredOption = Record<string, unknown> & { key: string; label?: string };

function isStoredOption(value: unknown): value is StoredOption {
  return (
    isRecord(value) && typeof value.key === "string" && (value.label === undefined || typeof value.label === "string")
  );
}

/** What an option write of issue #1699 leaves behind: the updated property row, its database and the written option's key. */
export interface PropertyOptionWrite {
  property: PropertyRow;
  database: DatabaseRow;
  optionKey: string;
}

/**
 * The start of both option writes of issue #1699: locks the property row until the caller's transaction ends and
 * returns it with its database and its stored options. Refuses an unknown property (`NotFoundError`), a property
 * that is not a `select` or `multi_select`, one that is itself `locked`, and stored options that
 * `assertValidSelectOptions` does not accept. The database's `schema_locked` flag is not checked, which is the
 * exception docs/adr/2026-11-10-select-options-change-on-a-schema-locked-database.md records.
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
  // `assertValidSelectOptions` accepted every element just above, so the guard only narrows the type.
  return { property, database, options: stored.filter(isStoredOption) };
}

/**
 * The label as it is stored: without surrounding whitespace and 1 to 60 UTF-16 code units long. A label that holds
 * U+0000 or a surrogate without its pair is refused as well: the `jsonb` column cannot hold either, so the `UPDATE`
 * would fail with a database error instead of this `ValidationError`.
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

/** A label as two labels are compared: without diacritics, surrounding whitespace and letter case. */
function foldLabel(label: string): string {
  return label.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

/**
 * Refuses `label` when one of `others` already has it, as its stored label or as the Czech or English catalog label
 * of its key; labels are compared as `foldLabel` returns them. The raw key an option without any label is displayed
 * by is not compared.
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
 * The key of a new option: the words of the label in ASCII camelCase. Diacritics are removed, and every other
 * character outside `A-Z`, `a-z` and `0-9` separates words. `option` when no word results. A key that `options`
 * already holds gets the lowest free numeric suffix from 2 up.
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

/** Writes `options` as the property's `config.options`, after the same config validation every config write runs. */
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
 * Appends one option to a `select` or `multi_select` property (issue #1699), also on a schema-locked database. The
 * key comes from the label (`newOptionKey`). Refused, besides what `lockPropertyForOptionWrite` and the config
 * validation refuse: a label another option already has (`OptionLabelExistsError` with that option's key), a label
 * that `parseOptionLabel` refuses and a property that already holds 100 options. The property row stays locked from
 * the read of its options until the caller's transaction ends, so two concurrent adds both end up stored.
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
 * Writes the label, the color or both of the option `optionKey` of a `select` or `multi_select` property (issue
 * #1699), also on a schema-locked database. The key and the option's position stay as they are. Refused, besides
 * what `lockPropertyForOptionWrite` and the config validation refuse: an unknown option key, a patch with neither
 * field, a label that `parseOptionLabel` refuses and a label another option of the property already has.
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
