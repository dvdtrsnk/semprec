import type { ModuleRegistry } from "@semprec/module-registry";
import {
  compareCollections,
  createCatalogResolver,
  createCollectionMetadataResolver,
  resolveDatabaseName,
  resolveDatabasePlaceholderForRow,
  resolveProperty,
  toManifestLocale,
  ValidationError,
  type CatalogResolver,
  type CollectionMetadataResolver,
  type ManifestLocale,
  type OrderableCollection,
} from "@semprec/data";
import type { Database, GenericApplicationPort, Property } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireUuidParam } from "./adapter/requestValidation.js";
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
  metadataResolver: CollectionMetadataResolver,
): Promise<ReturnType<typeof toDatabaseEnvelope>> {
  const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
  return toDatabaseEnvelope(
    database,
    resolveDatabaseName(database.name, database.key, database.id, catalogs, locale),
    await resolveDatabasePlaceholderForRow(catalogResolver, database, locale),
    metadataResolver.resolve(database),
  );
}

const DATABASE_LIST_PAGE_SIZE = 200;
const DEFAULT_LIST_LIMIT = 50;

/** Encodes the sort tuple of the last returned row, so a cursor stays valid after that row is archived. */
function encodeListCursor(row: OrderableCollection): string {
  const tuple = [row.switcherOrder, row.overviewOrder, row.name, row.id];
  return Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url");
}

function invalidCursor(): ValidationError {
  return new ValidationError("'cursor' is not a valid cursor", { field: "cursor" });
}

function isOrder(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function decodeListCursor(raw: string): OrderableCollection {
  let tuple: unknown;
  try {
    tuple = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(tuple) || tuple.length !== 4) throw invalidCursor();
  const [switcherOrder, overviewOrder, name, id] = tuple as unknown[];
  if (!isOrder(switcherOrder) || !isOrder(overviewOrder) || typeof name !== "string" || typeof id !== "string") {
    throw invalidCursor();
  }
  return { switcherOrder, overviewOrder, name, id };
}

/** Reads every page of `database.list`; the new order cannot be expressed by that operation's id-keyed cursor. */
async function listAllDatabases(service: GenericApplicationPort, userId: string): Promise<Database[]> {
  const all: Database[] = [];
  let cursor: string | undefined;
  do {
    const page = await dispatchGenericOperation(service, "database.list", restActor(userId), {
      cursor,
      limit: DATABASE_LIST_PAGE_SIZE,
    });
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/** `limit` keeps the `database.list` range: 1 to 200, default 50. */
function optionalLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return DEFAULT_LIST_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new ValidationError("'limit' must be an integer between 1 and 200", { field: "limit" });
  }
  return value;
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
        const limit = optionalLimit(query);
        const rawCursor = query.get("cursor");
        const after = rawCursor === null ? undefined : decodeListCursor(rawCursor);
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
        const rows = await listAllDatabases(service, ctx.identity.user.id);
        const entries = await Promise.all(
          rows.map(async (db) => {
            const catalogs = await catalogResolver.getCatalogsForDbKey(db.key);
            const metadata = metadataResolver.resolve(db);
            const sortable: OrderableCollection = {
              id: db.id,
              name: resolveDatabaseName(db.name, db.key, db.id, catalogs, locale),
              switcherOrder: metadata.switcherOrder,
              overviewOrder: metadata.overviewOrder,
            };
            return { db, sortable };
          }),
        );
        entries.sort((a, b) => compareCollections(a.sortable, b.sortable));
        const remaining =
          after === undefined ? entries : entries.filter((e) => compareCollections(e.sortable, after) > 0);
        const window = remaining.slice(0, limit);
        const databases = await Promise.all(
          window.map((e) => resolvedDatabaseBody(catalogResolver, e.db, locale, metadataResolver)),
        );
        const nextCursor = remaining.length > limit ? encodeListCursor(window[window.length - 1]!.sortable) : null;
        return { status: 200, body: { databases, nextCursor } };
      },
    },
    {
      method: "POST",
      path: "/api/databases",
      handler: async (ctx) => {
        const body = requireJsonObjectBody(ctx.body);
        const locale = toManifestLocale(ctx.identity.user.locale);
        const database = await dispatchGenericOperation(service, "database.create", restActor(ctx.identity.user.id), {
          ...body,
          titlePropertyName: body.titlePropertyName ?? (locale === "cs" ? "Název" : "Name"),
        });
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
        return { status: 201, body: await resolvedDatabaseBody(catalogResolver, database, locale, metadataResolver) };
      },
    },
    {
      method: "GET",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const database = await dispatchGenericOperation(service, "database.get", restActor(ctx.identity.user.id), {
          databaseId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale, metadataResolver) };
      },
    },
    {
      method: "PATCH",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const database = await dispatchGenericOperation(service, "database.patch", restActor(ctx.identity.user.id), {
          databaseId,
          patch: body,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale, metadataResolver) };
      },
    },
    {
      method: "DELETE",
      path: "/api/databases/:id",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const database = await dispatchGenericOperation(service, "database.archive", restActor(ctx.identity.user.id), {
          databaseId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale, metadataResolver) };
      },
    },
    {
      method: "POST",
      path: "/api/databases/:id/restore",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
        const database = await dispatchGenericOperation(service, "database.restore", restActor(ctx.identity.user.id), {
          databaseId,
        });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const metadataResolver = await createCollectionMetadataResolver(moduleRegistry);
        return { status: 200, body: await resolvedDatabaseBody(catalogResolver, database, locale, metadataResolver) };
      },
    },
    {
      method: "GET",
      path: "/api/databases/:id/properties",
      handler: async (ctx) => {
        const databaseId = requireUuidParam(ctx.params, "id");
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
        const databaseId = requireUuidParam(ctx.params, "id");
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
