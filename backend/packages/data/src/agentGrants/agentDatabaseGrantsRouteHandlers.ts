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

/**
 * The custom-route handler shape these exports are cast to by `semprec-api`'s mount (issue #239), duck-typed
 * here as in `pushRouteHandlers.ts`. The adapter authenticates a session before a handler runs, so a request
 * with an agent run credential never gets here, and it runs the handler inside the session's tenant.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { locale: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** One database as the Semp settings list it. */
interface ProjectDatabaseGrantBody {
  databaseId: string;
  key: string | null;
  /** The name in the caller's locale: the stored name, else the module catalog's label. */
  name: string;
  sensitive: boolean;
  system: boolean;
  access: ProjectDatabaseAccessRow["access"];
}

const projectIdSchema = z.uuid();

const patchBodySchema = z.strictObject({
  databaseId: z.uuid(),
  access: z.enum(["none", "read", "write"]),
});

function parseProjectId(params: Record<string, string>): string {
  const parsed = projectIdSchema.safeParse(params.id);
  if (!parsed.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
  return parsed.data;
}

let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * The resolver every database label is read through, built once per process from `loadFullModuleRegistry`: a
 * custom-route factory receives only the pool, so a handler cannot take the composition root's registry. A failed
 * build is not cached, so the next request retries instead of failing until restart.
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
 * `GET /api/projects/:id/database-grants` (issue #1841): every database a grant can matter for, the sensitive
 * ones and the user-created ones, with the project's current access (`none`, `read` or `write`). Shaped for one
 * consumer, the Collections list in the project's Semp settings, so it is the "single-consumer-read"
 * justification. A missing, trashed or other tenant's project answers 404.
 */
export function createListAgentDatabaseGrantsRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const projectItemId = parseProjectId(ctx.params);
    const locale = toManifestLocale(ctx.identity.user.locale);
    const catalogResolver = await getCatalogResolver();
    const entries = await withTransaction(pool, (client) => listAgentDatabaseGrantsForProject(client, projectItemId));
    const rows = await Promise.all(entries.map((entry) => toBody(catalogResolver, entry, locale)));
    return { status: 200, body: { rows } };
  };
}

/**
 * `PATCH /api/projects/:id/database-grants` (issue #1841): sets the project's access to one database from the
 * body `{ databaseId, access }`. The decision row and the locks that guard it share one transaction with the
 * write, the "transactional-semantics" justification. The body is validated before the transaction opens, so a
 * malformed request writes nothing. Answers the database as the list shows it.
 */
export function createPatchAgentDatabaseGrantRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const projectItemId = parseProjectId(ctx.params);
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
