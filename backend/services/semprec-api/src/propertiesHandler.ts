import type { ModuleRegistry } from "@semprec/module-registry";
import { createCatalogResolver, resolveProperty, toManifestLocale } from "@semprec/data";
import type { GenericApplicationPort } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import { requireJsonObjectBody, requireStringParam } from "./adapter/requestValidation.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { toPropertyEnvelope } from "./adapter/propertyEnvelope.js";

/**
 * The property endpoint family (issue #240, rebased onto the generic-operation bindings by issue
 * #219): `GET/PATCH/DELETE /api/properties/:id`. `PATCH` sends only the fields present in the
 * request body as `property.patch`'s `patch` object — an empty body is `validation_failed`
 * (`reason: 'empty_patch'`) rather than a silent no-op, and a relation-typed property's `type`/
 * `config` is rejected with `reason: 'relation_definition_required'` (rename remains allowed); both
 * rejections are raised by `packages/application`'s service, not reimplemented here. No successful
 * mutation returns 204.
 */
export function createPropertyRoutes(
  service: GenericApplicationPort,
  moduleRegistry: ModuleRegistry,
): RouteDefinition[] {
  return [
    {
      method: "PATCH",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const propertyId = requireStringParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        const body = requireJsonObjectBody(ctx.body);

        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.config !== undefined) patch.config = body.config;
        if (body.type !== undefined) patch.type = body.type;

        const property = await dispatchGenericOperation(service, "property.patch", actor, { propertyId, patch });

        const locale = toManifestLocale(ctx.identity.user.locale);
        const database = await dispatchGenericOperation(service, "database.get", actor, {
          databaseId: property.databaseId,
        });
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
        const resolved = resolveProperty(property, database.key, catalogs, locale);
        return { status: 200, body: toPropertyEnvelope(property, resolved) };
      },
    },
    {
      method: "DELETE",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const propertyId = requireStringParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);

        const property = await dispatchGenericOperation(service, "property.get", actor, { propertyId });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const database = await dispatchGenericOperation(service, "database.get", actor, {
          databaseId: property.databaseId,
        });
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
        const resolved = resolveProperty(property, database.key, catalogs, locale);
        const body = toPropertyEnvelope(property, resolved);

        await dispatchGenericOperation(service, "property.delete", actor, { propertyId });
        return { status: 200, body };
      },
    },
    {
      method: "GET",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const propertyId = requireStringParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);

        const property = await dispatchGenericOperation(service, "property.get", actor, { propertyId });
        const locale = toManifestLocale(ctx.identity.user.locale);
        const database = await dispatchGenericOperation(service, "database.get", actor, {
          databaseId: property.databaseId,
        });
        const catalogResolver = await createCatalogResolver(moduleRegistry);
        const catalogs = await catalogResolver.getCatalogsForDbKey(database.key);
        const resolved = resolveProperty(property, database.key, catalogs, locale);
        return { status: 200, body: toPropertyEnvelope(property, resolved) };
      },
    },
  ];
}
