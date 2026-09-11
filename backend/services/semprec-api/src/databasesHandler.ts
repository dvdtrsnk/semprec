import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  createChokePoint,
  createCatalogResolver,
  resolveDatabaseName,
  resolveProperty,
  toManifestLocale,
  NotFoundError,
  type ChokePoint,
  type DatabaseRow,
  type ManifestLocale,
  type PropertyType,
} from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringField, requireStringParam } from "./adapter/requestValidation.js";
import { toDatabaseEnvelope } from "./adapter/databaseEnvelope.js";
import { toPropertyEnvelope } from "./adapter/propertyEnvelope.js";

/**
 * Resolves `database`'s display name through issue #35's localized-metadata catalog and projects
 * it onto the #240 wire envelope — the one place every database route (list/create/detail/patch/
 * archive) turns a `DatabaseRow` into its response body, so a system database's `name: null`
 * override slot is never sent to a REST caller as a literal `null`.
 */
async function resolvedDatabaseBody(
  moduleRegistry: ModuleRegistry,
  database: DatabaseRow,
  locale: ManifestLocale,
): Promise<ReturnType<typeof toDatabaseEnvelope>> {
  const catalogResolver = await createCatalogResolver(moduleRegistry);
  const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
  return toDatabaseEnvelope(database, resolveDatabaseName(database.name, database.key, database.id, catalogs, locale));
}

async function requireDatabase(chokePoint: ChokePoint, id: string): Promise<DatabaseRow> {
  const database = await chokePoint.getDatabase(id);
  if (!database) throw new NotFoundError(`Database ${id} not found`);
  return database;
}

/**
 * The database endpoint family (issue #240): `GET/POST /api/databases`, `GET/PATCH/DELETE
 * /api/databases/:id` (`DELETE` archives rather than hard-deleting — a `system: true` database
 * 403s on both, enforced by `chokePoint.archiveDatabase` itself), and `POST
 * /api/databases/:id/properties`. Every route is a thin mapping onto `createChokePoint`'s
 * service calls — no business rule is reimplemented here, and no successful mutation returns 204.
 */
export function createDatabaseRoutes(pool: Pool, moduleRegistry: ModuleRegistry): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);

  return [
    {
      method: "GET",
      path: "/api/databases",
      handler: async (ctx) => {
        const locale = toManifestLocale(ctx.identity.user.locale);
        const databases = await chokePoint.listDatabases();
        const body = await Promise.all(databases.map((db) => resolvedDatabaseBody(moduleRegistry, db, locale)));
        return { status: 200, body: { databases: body } };
      },
    },
    {
      method: "POST",
      path: "/api/databases",
      handler: async (ctx) => {
        const body = requireJsonObjectBody(ctx.body);
        const name = typeof body.name === "string" ? body.name : null;
        const parentItemId = typeof body.parentItemId === "string" ? body.parentItemId : undefined;
        const ownerProjectItemId = typeof body.ownerProjectItemId === "string" ? body.ownerProjectItemId : undefined;
        const database = await chokePoint.createDatabase({ name, parentItemId, ownerProjectItemId });
        const locale = toManifestLocale(ctx.identity.user.locale);
        return { status: 201, body: await resolvedDatabaseBody(moduleRegistry, database, locale) };
      },
    },
    {
      method: "GET",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const database = await requireDatabase(chokePoint, requireStringParam(ctx.params, "id"));
        const locale = toManifestLocale(ctx.identity.user.locale);
        return { status: 200, body: await resolvedDatabaseBody(moduleRegistry, database, locale) };
      },
    },
    {
      method: "PATCH",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const name = requireStringField(body, "name");
        const database = await chokePoint.renameDatabase(id, name);
        const locale = toManifestLocale(ctx.identity.user.locale);
        return { status: 200, body: await resolvedDatabaseBody(moduleRegistry, database, locale) };
      },
    },
    {
      method: "DELETE",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const database = await chokePoint.archiveDatabase(requireStringParam(ctx.params, "id"));
        const locale = toManifestLocale(ctx.identity.user.locale);
        return { status: 200, body: await resolvedDatabaseBody(moduleRegistry, database, locale) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/properties",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const key = requireStringField(body, "key");
        // Validity of `type` itself (one of `PROPERTY_TYPES`) is `propertiesStore.createProperty`'s
        // own domain check, not duplicated here — this only asserts the request-shape invariant
        // that a `type` field was sent at all.
        const type = requireStringField(body, "type") as PropertyType;
        const name = typeof body.name === "string" ? body.name : null;
        const config =
          typeof body.config === "object" && body.config !== null && !Array.isArray(body.config)
            ? (body.config as Record<string, unknown>)
            : undefined;
        const property = await chokePoint.createProperty({ databaseId, key, name, type, config });
        const database = await requireDatabase(chokePoint, databaseId);
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
        const resolved = resolveProperty(property, database.key, catalogs, locale);
        return { status: 201, body: toPropertyEnvelope(property, resolved) };
      },
    },
  ];
}
