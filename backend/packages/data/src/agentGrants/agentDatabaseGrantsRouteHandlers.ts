import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import {
  createCatalogResolver,
  resolveDatabaseName,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
} from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import type { ProjectDatabaseAccessRow } from "./agentDatabaseAccess.js";
import {
  listAgentDatabaseGrantsForProject,
  setAgentDatabaseGrantForProjectSettings,
} from "./agentDatabaseGrantsForProject.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteLocale } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

interface ProjectDatabaseGrantBody {
  databaseId: string;
  key: string | null;
  /** The stored name, else the module catalog's label in the caller's locale. */
  name: string;
  sensitive: boolean;
  system: boolean;
  access: ProjectDatabaseAccessRow["access"];
}

const patchBodySchema = z.strictObject({
  databaseId: z.uuid(),
  access: z.enum(["none", "read", "write"]),
});

let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * Built once per process: a custom-route factory receives only the pool, not the composition root's registry.
 * A failed build is not cached, so the next request retries.
 */
function getCatalogResolver(): Promise<CatalogResolver> {
  catalogResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      catalogResolverPromise = undefined;
      throw error;
    });
  return catalogResolverPromise;
}

async function toBody(
  catalogResolver: CatalogResolver,
  row: ProjectDatabaseAccessRow,
  locale: ManifestLocale,
): Promise<ProjectDatabaseGrantBody> {
  const catalogs = await catalogResolver.getCatalogsForDbKey(row.key);
  return {
    databaseId: row.databaseId,
    key: row.key,
    name: resolveDatabaseName(row.name, row.key, row.databaseId, catalogs, locale),
    sensitive: row.sensitive,
    system: row.system,
    access: row.access,
  };
}

/**
 * `GET /api/projects/:id/database-grants`: shaped for its single consumer, the Semp settings Collections list.
 * A missing, trashed or foreign project is 404. Session-only: an agent run credential never reaches it.
 */
export function createListAgentDatabaseGrantsRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteLocale): Promise<CustomRouteResult> => {
    const projectItemId = requireUuidParam(ctx.params, "id");
    const locale = toManifestLocale(ctx.identity.user.locale);
    const catalogResolver = await getCatalogResolver();
    const entries = await withTransaction(pool, (client) => listAgentDatabaseGrantsForProject(client, projectItemId));
    const rows = await Promise.all(entries.map((entry) => toBody(catalogResolver, entry, locale)));
    return { status: 200, body: { rows } };
  };
}

/**
 * `PATCH /api/projects/:id/database-grants` with `{ databaseId, access }`: the locks and the write share one
 * transaction. The body is validated before the transaction opens.
 */
export function createPatchAgentDatabaseGrantRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteLocale): Promise<CustomRouteResult> => {
    const projectItemId = requireUuidParam(ctx.params, "id");
    const body = patchBodySchema.safeParse(ctx.body);
    if (!body.success) {
      const field = body.error.issues[0]?.path[0];
      throw new ValidationError("Invalid database grant", { field: typeof field === "string" ? field : "body" });
    }
    const locale = toManifestLocale(ctx.identity.user.locale);
    const catalogResolver = await getCatalogResolver();
    const entry = await withTransaction(pool, (client) =>
      setAgentDatabaseGrantForProjectSettings(client, { projectItemId, ...body.data }),
    );
    return { status: 200, body: await toBody(catalogResolver, entry, locale) };
  };
}
