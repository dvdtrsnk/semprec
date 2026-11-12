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
 * The property endpoint family (issue #240, rebased onto the generic-operation bindings by issue
 * #219): `GET /api/properties` (list), `GET/PATCH/DELETE /api/properties/:id`. `PATCH` sends only
 * the fields present in the request body as `property.patch`'s `patch` object — an empty body is
 * `validation_failed` (`reason: 'empty_patch'`) rather than a silent no-op, and a relation-typed
 * property's `type`/`config` is rejected with `reason: 'relation_definition_required'` (rename
 * remains allowed); both rejections are raised by `packages/application`'s service, not
 * reimplemented here. No successful mutation returns 204.
 *
 * `GET /api/properties?databaseId=` and `GET /api/properties/:id` return the authoritative raw
 * `property.list`/`property.get` binding output verbatim (issue #219's Task: "so agents can
 * discover relation property ids"), including `config` — a relation property's
 * `relationDefinitionId`/`targetDatabaseId` live there. This is deliberately a different shape
 * from `GET /api/databases/:id/properties` (`databasesHandler.ts`'s pre-existing, unrelated
 * `PropertyCatalogEntry[]`), which stays a localized display projection for the web client's
 * `listProperties` and is out of this issue's scope to change.
 *
 * `POST /api/properties/:id/options` and `PATCH /api/properties/:id/options/:key` (issue #1699) add an option to
 * a select or multi_select property and rename or recolor one, also on a schema-locked database
 * (docs/adr/2026-11-10-select-options-change-on-a-schema-locked-database.md). Both answer with the option as
 * `{ key, label, color? }`; the add answers 201. The `:key` segment is the option key percent-encoded as a path
 * segment and is decoded once before the lookup, because a stored key may hold a space, a non-ASCII letter or a
 * `/`; a segment that is not valid percent-encoding answers 400 `validation_failed` naming `key`.
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

        // The owning `Database` row comes from `property.patch`'s own transaction via
        // `patchPropertyWithDatabase` (issue #789), not a separate `database.get` dispatch after
        // the patch has already committed — a database deleted between the two calls can no
        // longer surface as an independent not-found failure for an update that already
        // succeeded. `parseOperationInput` validates the same way `dispatchGenericOperation`
        // would for `property.patch`; `patchPropertyWithDatabase` isn't one of the 44 catalog
        // operations, so it's called directly on `service` instead.
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

        // The deleted row comes back from `property.delete` itself — the state it reports is
        // exactly the state the deletion transaction saw, not a separately-fetched snapshot that
        // could go stale between reading it and deleting it (issue #219).
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
        // An option key is any non-empty string, so the segment is decoded before it is compared with the stored key.
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
