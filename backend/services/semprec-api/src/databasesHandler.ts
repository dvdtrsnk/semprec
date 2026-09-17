import type { ModuleRegistry } from "@semprec/module-registry";
import {
  createCatalogResolver,
  resolveDatabaseName,
  resolveProperty,
  toManifestLocale,
  ValidationError,
  type CatalogResolver,
  type ManifestLocale,
} from "@semprec/data";
import type { Database, GenericApplicationPort, Property } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { toDatabaseEnvelope } from "./adapter/databaseEnvelope.js";
import { toPropertyEnvelope } from "./adapter/propertyEnvelope.js";

interface PropertyCatalogEntry {
  id: string;
  databaseId: string;
  key: string;
  type: Property["type"];
  label: string;
  options?: { key: string; label: string }[];
  locked: boolean;
  owner: "user" | "system";
  ownerProcess: string | null;
  migrationStatus: string;
}

function toPropertyCatalogEntry(
  property: Property,
  label: string,
  options: PropertyCatalogEntry["options"],
): PropertyCatalogEntry {
  return {
    id: property.id,
    databaseId: property.databaseId,
    key: property.key,
    type: property.type,
    label,
    ...(options === undefined ? {} : { options }),
    locked: property.locked,
    owner: property.owner,
    ownerProcess: property.ownerProcess,
    migrationStatus: property.migrationStatus,
  };
}

/**
 * Resolves `database`'s display name through issue #35's localized-metadata catalog and projects
 * it onto the #240 wire envelope — the one place every database route (list/create/detail/patch/
 * archive/restore) turns a generic-catalog `Database` into its response body, so a system
 * database's `name: null` override slot is never sent to a REST caller as a literal `null`.
 */
async function resolvedDatabaseBody(
  catalogResolver: CatalogResolver,
  database: Database,
  locale: ManifestLocale,
): Promise<ReturnType<typeof toDatabaseEnvelope>> {
  const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
  return toDatabaseEnvelope(database, resolveDatabaseName(database.name, database.key, database.id, catalogs, locale));
}

function optionalIntegerQueryParam(query: URLSearchParams, name: string): number | undefined {
  const value = query.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError(`Query parameter '${name}' must be an integer`, { field: name });
  }
  return parsed;
}

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

/**
 * The database endpoint family (issue #240, rebased onto the generic-operation bindings by issue
 * #219): `GET/POST /api/databases`, `GET/PATCH/DELETE/POST .../restore /api/databases/:id`, and
 * `GET/POST /api/databases/:id/properties`. Every route assembles a canonical command object,
 * validates and dispatches it through `dispatchGenericOperation` against the one
 * `GenericApplicationPort` instance the composition root (`app.ts`) injects — no route constructs
 * its own `createChokePoint(pool)`. `GET /api/databases/:id/properties` is the sole exception to
 * "response mirrors the binding output verbatim": it keeps its established localized
 * `PropertyCatalogEntry[]` shape, since the web frontend's `listProperties` client consumes it.
 */
export function createDatabaseRoutes(
  service: GenericApplicationPort,
  moduleRegistry: ModuleRegistry,
): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/databases",
      handler: async (ctx) => {
        const query = requestUrl(ctx.req.url).searchParams;
        const page = await dispatchGenericOperation(service, "database.list", restActor(ctx.identity.user.id), {
          cursor: query.get("cursor") ?? undefined,
          limit: optionalIntegerQueryParam(query, "limit"),
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const databases = await Promise.all(page.items.map((db) => resolvedDatabaseBody(catalogResolver, db, locale)));
        return { status: 200, body: { databases, nextCursor: page.nextCursor } };
      },
    },
    {
      method: "POST",
      path: "/api/databases",
      handler: async (ctx) => {
        const body = requireJsonObjectBody(ctx.body);
        const database = await dispatchGenericOperation(service, "database.create", restActor(ctx.identity.user.id), {
          name: body.name,
          parentItemId: body.parentItemId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        return { status: 201, body: await resolvedDatabaseBody(catalogResolver, database, locale) };
      },
    },
    {
      method: "GET",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const database = await dispatchGenericOperation(service, "database.get", restActor(ctx.identity.user.id), {
          databaseId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale) };
      },
    },
    {
      method: "PATCH",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        const database = await dispatchGenericOperation(service, "database.patch", restActor(ctx.identity.user.id), {
          databaseId,
          patch,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale) };
      },
    },
    {
      method: "DELETE",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const database = await dispatchGenericOperation(service, "database.archive", restActor(ctx.identity.user.id), {
          databaseId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/restore",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const database = await dispatchGenericOperation(service, "database.restore", restActor(ctx.identity.user.id), {
          databaseId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale) };
      },
    },
    {
      method: "GET",
      path: "/api/databases/:id/properties",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        const database = await dispatchGenericOperation(service, "database.get", actor, { databaseId });
        const properties = await dispatchGenericOperation(service, "property.list", actor, { databaseId });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
        const body = properties.map((property) => {
          const resolved = resolveProperty(property, database.key, catalogs, locale);
          return toPropertyCatalogEntry(property, resolved.name, resolved.options);
        });
        return { status: 200, body: { properties: body } };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/properties",
      handler: async (ctx) => {
        const databaseId = requireStringParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        const database = await dispatchGenericOperation(service, "database.get", actor, { databaseId });
        const body = requireJsonObjectBody(ctx.body);
        const rawInput =
          body.type === "relation"
            ? {
                databaseId,
                key: body.key,
                name: body.name,
                type: "relation",
                targetDatabaseId: body.targetDatabaseId,
                cardinality: body.cardinality,
                locked: body.locked,
                inverse: body.inverse,
              }
            : { databaseId, key: body.key, name: body.name, type: body.type, config: body.config };
        const property = await dispatchGenericOperation(service, "property.create", actor, rawInput);
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
        const resolved = resolveProperty(property, database.key, catalogs, locale);
        return { status: 201, body: toPropertyEnvelope(property, resolved) };
      },
    },
  ];
}
