import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  createChokePoint,
  createCatalogResolver,
  resolveProperty,
  toManifestLocale,
  NotFoundError,
  type PropertyType,
} from "@semprec/data";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { toPropertyEnvelope } from "./adapter/propertyEnvelope.js";

/**
 * The property endpoint family (issue #240): `PATCH/DELETE /api/properties/:id`. Thin mappings
 * onto `createChokePoint`'s property service calls — `renameProperty`/`updatePropertyConfig`
 * enforce `schema_locked`/`locked` themselves (403 with the matching error code, see
 * `chokePoint/propertiesStore.ts`'s `assertPropertySchemaMutable`/`assertDatabaseSchemaUnlocked`),
 * and `changePropertyType` enqueues the existing `migration_status` job (issue #21) rather than
 * migrating inline — this handler answers 202 for that case, never performing the migration
 * itself. No successful mutation returns 204.
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
        let property = await chokePoint.getProperty(id);
        if (!property) throw new NotFoundError(`Property ${id} not found`);

        if (typeof body.name === "string") {
          property = await chokePoint.renameProperty(id, body.name);
        }
        if (typeof body.config === "object" && body.config !== null && !Array.isArray(body.config)) {
          property = await chokePoint.updatePropertyConfig(id, body.config as Record<string, unknown>);
        }

        let status = 200;
        if (typeof body.type === "string" && body.type !== property.type) {
          property = await chokePoint.changePropertyType(id, body.type as PropertyType);
          status = 202;
        }

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

        await chokePoint.deleteProperty(id);
        return { status: 200, body };
      },
    },
  ];
}
