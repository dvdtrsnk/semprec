import type { ModuleRegistry } from "@semprec/module-registry";
import { createCatalogResolver, resolveProperty, toManifestLocale } from "@semprec/data";
import type { GenericApplicationPort } from "@semprec/shared";
import type { RouteDefinition } from "./adapter/routeTable.js";
import {
  requireDecodedStringParam,
  requireJsonObjectBody,
  requireStringQueryParam,
  requireUuidParam,
} from "./adapter/requestValidation.js";
import { dispatchGenericOperation, parseOperationInput, restActor } from "./adapter/genericBinding.js";
import { toPropertyEnvelope } from "./adapter/propertyEnvelope.js";

function requestUrl(rawUrl: string | undefined): URL {
  return new URL(rawUrl ?? "/", "http://localhost");
}

/**
 * `PATCH` sends only the fields present as `property.patch`'s `patch`; an empty body is
 * `validation_failed` (`empty_patch`) and a relation property's `type`/`config` is rejected
 * (`relation_definition_required`), both raised by the application service.
 *
 * `GET /api/properties?databaseId=` and `GET /api/properties/:id` return the raw binding output
 * including `config`, so agents can discover relation definition and target ids. This deliberately
 * differs from `GET /api/databases/:id/properties`, a localized projection for the web client.
 *
 * `POST /api/properties/:id/options` and `PATCH /api/properties/:id/options/:key` add or
 * rename/recolor a select option, also on a schema-locked database, and answer with the option (201
 * for the add). `DELETE /api/properties/:id/options/:key` removes the option and its key from every
 * item value and answers 204 with no body. `:key` is decoded once because a stored
 * key may hold a space, non-ASCII or `/`; invalid percent-encoding is 400 naming `key`.
 */
export function createPropertyRoutes(
  service: GenericApplicationPort,
  moduleRegistry: ModuleRegistry,
): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/properties",
      handler: async (ctx) => {
        const query = requestUrl(ctx.req.url).searchParams;
        const databaseId = requireStringQueryParam(query, "databaseId");
        const properties = await dispatchGenericOperation(service, "property.list", restActor(ctx.identity.user.id), {
          databaseId,
        });
        return { status: 200, body: { properties } };
      },
    },
    {
      method: "PATCH",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const propertyId = requireUuidParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);
        const body = requireJsonObjectBody(ctx.body);

        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.config !== undefined) patch.config = body.config;
        if (body.type !== undefined) patch.type = body.type;

        // `patchPropertyWithDatabase` returns the owning database from `property.patch`'s own
        // transaction, so a database deleted between two calls cannot surface as a not-found for an
        // update that already succeeded. It is not a catalog operation, so the input is validated
        // with `parseOperationInput` and the method called directly.
        const input = parseOperationInput("property.patch", { propertyId, patch });
        const { property, database } = await service.patchPropertyWithDatabase(actor, input);

        const locale = toManifestLocale(ctx.identity.user.locale);
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
        const propertyId = requireUuidParam(ctx.params, "id");
        const actor = restActor(ctx.identity.user.id);

        // The deleted row comes back from `property.delete` itself: exactly the state the deletion
        // transaction saw.
        const property = await dispatchGenericOperation(service, "property.delete", actor, { propertyId });
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
      method: "POST",
      path: "/api/properties/:id/options",
      handler: async (ctx) => {
        const propertyId = requireUuidParam(ctx.params, "id");
        const body = requireJsonObjectBody(ctx.body);
        const option = await dispatchGenericOperation(service, "property.option.add", restActor(ctx.identity.user.id), {
          propertyId,
          label: body.label,
          color: body.color,
        });
        return { status: 201, body: option };
      },
    },
    {
      method: "PATCH",
      path: "/api/properties/:id/options/:key",
      handler: async (ctx) => {
        const propertyId = requireUuidParam(ctx.params, "id");
        // An option key is any non-empty string, so the segment is decoded before comparison.
        const key = requireDecodedStringParam(ctx.params, "key");
        const body = requireJsonObjectBody(ctx.body);
        const option = await dispatchGenericOperation(
          service,
          "property.option.update",
          restActor(ctx.identity.user.id),
          { propertyId, key, label: body.label, color: body.color },
        );
        return { status: 200, body: option };
      },
    },
    {
      method: "DELETE",
      path: "/api/properties/:id/options/:key",
      handler: async (ctx) => {
        const propertyId = requireUuidParam(ctx.params, "id");
        const key = requireDecodedStringParam(ctx.params, "key");
        await dispatchGenericOperation(service, "property.option.remove", restActor(ctx.identity.user.id), {
          propertyId,
          key,
        });
        return { status: 204, body: undefined };
      },
    },
    {
      method: "GET",
      path: "/api/properties/:id",
      handler: async (ctx) => {
        const propertyId = requireUuidParam(ctx.params, "id");
        const property = await dispatchGenericOperation(service, "property.get", restActor(ctx.identity.user.id), {
          propertyId,
        });
        return { status: 200, body: property };
      },
    },
  ];
}
