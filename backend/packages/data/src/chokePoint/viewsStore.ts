import type { PoolClient } from "pg";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { CreatedBy, ViewRow } from "../types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { parseViewConfig, type ViewConfig } from "../views/viewConfig.js";
import { getDatabase } from "./databasesStore.js";
import { isBuiltinViewType, isKnownViewType, type ViewTypeRegistry } from "./viewTypeRegistry.js";

const CREATED_BY_VALUES: readonly CreatedBy[] = ["user", "ai_agent", "system"];
const VIEW_COLUMNS = "id, database_id, type, name, config, is_default, owner_module_id, created_by";

function mapViewRow(row: {
  id: string;
  database_id: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  is_default: boolean;
  owner_module_id: string | null;
  created_by: string;
}): ViewRow {
  return {
    id: row.id,
    databaseId: row.database_id,
    type: row.type,
    name: row.name,
    config: row.config,
    isDefault: row.is_default,
    ownerModuleId: row.owner_module_id,
    createdBy: assertKnownValue(CREATED_BY_VALUES, row.created_by, "view created_by"),
  };
}

/** True when a Postgres error is the named unique-index violation, so callers can turn it into a clean ConflictError. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr?.constraint === constraint;
}

export interface CreateViewInput {
  /** Set for a linked/filtered view (must reference an existing database); omit/null for a curated view. */
  databaseId?: string | null;
  type: string;
  name: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
  ownerModuleId?: string;
  createdBy?: CreatedBy;
}

export async function createView(client: PoolClient, input: CreateViewInput, viewTypeRegistry: ViewTypeRegistry): Promise<ViewRow> {
  const createdBy = input.createdBy ?? "user";
  if (createdBy === "ai_agent" && input.isDefault) {
    throw new ForbiddenError("is_default cannot be set by an agent, not even on its own view", { field: "isDefault" }, "owner_violation");
  }
  if (!isKnownViewType(viewTypeRegistry, input.type)) {
    throw new ValidationError(`Unknown view type '${input.type}'; register it via the view-type registry first`, { field: "type" });
  }
  if (input.ownerModuleId && isBuiltinViewType(input.type)) {
    throw new ValidationError("ownerModuleId may only be set for a custom, module-registered view type", { field: "ownerModuleId" });
  }

  const config = parseViewConfig(input.config ?? {});
  const isCurated = config.membership === "manual";
  if (isCurated && input.databaseId) {
    throw new ValidationError("A curated view (config.membership = 'manual') cannot have a databaseId", { field: "databaseId" });
  }
  if (!isCurated && !input.databaseId) {
    throw new ValidationError("A filtered/linked view requires a databaseId", { field: "databaseId" });
  }
  if (input.databaseId) {
    const database = await getDatabase(client, input.databaseId);
    if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`);
  }

  const definition = viewTypeRegistry.get(input.type);
  definition?.service?.validateConfig?.(config);

  try {
    const { rows } = await client.query(
      `INSERT INTO views (database_id, type, name, config, is_default, owner_module_id, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING ${VIEW_COLUMNS}`,
      [input.databaseId ?? null, input.type, input.name, JSON.stringify(config), input.isDefault ?? false, input.ownerModuleId ?? null, createdBy],
    );
    return mapViewRow(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err, "views_one_default_per_db")) {
      throw new ConflictError(`Database ${input.databaseId} already has a default view`, { field: "isDefault" });
    }
    throw err;
  }
}

export async function getView(client: PoolClient, id: string): Promise<ViewRow | null> {
  const { rows } = await client.query(`SELECT ${VIEW_COLUMNS} FROM views WHERE id = $1`, [id]);
  return rows[0] ? mapViewRow(rows[0]) : null;
}

async function requireView(client: PoolClient, id: string): Promise<ViewRow> {
  const view = await getView(client, id);
  if (!view) throw new NotFoundError(`View ${id} not found`);
  return view;
}

export async function listViewsByDatabase(client: PoolClient, databaseId: string): Promise<ViewRow[]> {
  const { rows } = await client.query(`SELECT ${VIEW_COLUMNS} FROM views WHERE database_id = $1 ORDER BY name`, [databaseId]);
  return rows.map(mapViewRow);
}

export async function listCuratedViews(client: PoolClient): Promise<ViewRow[]> {
  const { rows } = await client.query(`SELECT ${VIEW_COLUMNS} FROM views WHERE database_id IS NULL ORDER BY name`);
  return rows.map(mapViewRow);
}

export interface PatchViewInput {
  name?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
  /** Set only by the choke-point's ai_agent -> user adoption on a user write; never accepted directly from an API payload. */
  createdBy?: CreatedBy;
}

export async function patchView(client: PoolClient, id: string, patch: PatchViewInput): Promise<ViewRow> {
  const view = await requireView(client, id);

  let nextConfig: ViewConfig | undefined;
  if (patch.config !== undefined) {
    nextConfig = parseViewConfig(patch.config);
    const wasCurated = view.databaseId === null;
    const willBeCurated = nextConfig.membership === "manual";
    if (wasCurated !== willBeCurated) {
      throw new ValidationError("A view cannot switch between curated and filtered/linked via patch", { field: "config.membership" });
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown, cast?: string) => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast ?? ""}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (nextConfig !== undefined) set("config", JSON.stringify(nextConfig), "::jsonb");
  if (patch.isDefault !== undefined) set("is_default", patch.isDefault);
  if (patch.createdBy !== undefined) set("created_by", patch.createdBy);
  if (sets.length === 0) return view;

  params.push(id);
  try {
    const { rows } = await client.query(`UPDATE views SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${VIEW_COLUMNS}`, params);
    return mapViewRow(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err, "views_one_default_per_db")) {
      throw new ConflictError(`Database ${view.databaseId} already has a default view`, { field: "isDefault" });
    }
    throw err;
  }
}

export async function deleteView(client: PoolClient, id: string): Promise<void> {
  await client.query(`DELETE FROM views WHERE id = $1`, [id]);
}
