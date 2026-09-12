import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  createChokePoint,
  createCatalogResolver,
  resolveProperty,
  toManifestLocale,
  NotFoundError,
  ValidationError,
  PROPERTY_TYPES,
  type PropertyType,
} from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { toPropertyEnvelope } from "./adapter/propertyEnvelope.js";

/**
 * The property endpoint family (issue #240): `PATCH/DELETE /api/properties/:id`. `PATCH` applies
 * whichever of `name`/`config`/`type` were sent through `chokePoint.updateProperty` in a single
 * transaction, so a `schema_locked`/`locked` 403 from the config/type change (see
 * `chokePoint/propertiesStore.ts`'s `assertPropertySchemaMutable`/`assertDatabaseSchemaUnlocked`)
 * rolls back a rename requested in the same call instead of leaving it committed against the
 * caller's expectation that a 403 means nothing changed. A `type` change enqueues the existing
 * `migration_status` job (issue #21) rather than migrating inline — this handler answers 202 for
 * that case, never performing the migration itself. No successful mutation returns 204.
 */
export function createPropertyRoutes(pool: Pool, moduleRegistry: ModuleRegistry): RouteDefinition[] {
  const chokePoint = createChokePoint(pool);

  return [
    {
      method: "PATCH",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);

        const name = typeof body.name === "string" ? body.name : undefined;
        const config =
          typeof body.config === "object" && body.config !== null && !Array.isArray(body.config)
            ? (body.config as Record<string, unknown>)
            : undefined;
        let type: PropertyType | undefined;
        if (typeof body.type === "string") {
          if (!PROPERTY_TYPES.includes(body.type as PropertyType)) {
            throw new ValidationError(`Unknown property type '${body.type}'`, { field: "type" });
          }
          type = body.type as PropertyType;
        }

        const { property, typeChanged } = await chokePoint.updateProperty(
          id,
          { name, config, type },
          ctx.identity.user.id,
        );
        const status = typeChanged ? 202 : 200;

        const locale = toManifestLocale(ctx.identity.user.locale);
        const database = await chokePoint.getDatabase(property.databaseId);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database?.key ?? null);
        const resolved = resolveProperty(property, database?.key ?? null, catalogs, locale);
        return { status, body: toPropertyEnvelope(property, resolved) };
      },
    },
    {
      method: "DELETE",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const id = requireStringParam(ctx.params, "id");
        const property = await chokePoint.getProperty(id);
        if (!property) throw new NotFoundError(`Property ${id} not found`);

        const locale = toManifestLocale(ctx.identity.user.locale);
        const database = await chokePoint.getDatabase(property.databaseId);
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database?.key ?? null);
        const resolved = resolveProperty(property, database?.key ?? null, catalogs, locale);
        const body = toPropertyEnvelope(property, resolved);

        await chokePoint.deleteProperty(id, ctx.identity.user.id);
        return { status: 200, body };
      },
    },
  ];
}
