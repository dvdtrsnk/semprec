import type { PoolClient } from "pg";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { resolveProperty, toManifestLocale } from "../manifest/catalogResolution.js";
import { computeDatabaseFacets, loadFacetMetadata } from "../views/facetQuery.js";

export const MAX_CATALOG_TEXT_PROPERTIES = 5;

/**
 * A bound, not a quota: the facets read takes the 20 most frequent first and then drops values over
 * `MAX_CATALOG_TEXT_VALUE_LENGTH`, so fewer may be listed.
 */
export const MAX_CATALOG_TEXT_VALUES = 20;

/** Longer text is a note, not a reusable value, so it is left out whole: a cut value would look like a stored one. */
export const MAX_CATALOG_TEXT_VALUE_LENGTH = 100;

export interface TargetCatalogSelect {
  propertyKey: string;
  multi: boolean;
  options: Array<{ key: string; label: string }>;
}

export interface TargetCatalogTextValues {
  propertyKey: string;
  /** Values already stored, with the number of live items holding each. */
  values: Array<{ value: string; count: number }>;
}

export interface TargetCatalog {
  selects: TargetCatalogSelect[];
  textValues: TargetCatalogTextValues[];
}

/**
 * The grounding catalog of one target database, read in the caller's tenant transaction.
 *
 * `selects`: every user-owned `select`/`multi_select` property with option keys and labels in `locale` (`cs`, else
 * `en`). This is schema, so it is returned whatever the reader may read.
 *
 * `textValues`: for the first `MAX_CATALOG_TEXT_PROPERTIES` user-owned `text` properties, the values in use with
 * counts via `computeDatabaseFacets`. These are data, so they are read only when project `projectItemId` may read the
 * database (`listUnreadableDatabaseIds`); otherwise empty. An unknown or other-tenant database has an empty catalog.
 */
export async function buildTargetCatalog(
  client: PoolClient,
  databaseId: string,
  locale: string,
  projectItemId: string,
): Promise<TargetCatalog> {
  const database = await getDatabase(client, databaseId);
  if (!database) return { selects: [], textValues: [] };
  const properties = await listPropertiesByDatabase(client, database.id);
  const metadata = await loadFacetMetadata();
  const catalogs = await metadata.catalogResolver.getCatalogsForDbKey(database.key);
  const manifestLocale = toManifestLocale(locale);

  const selects: TargetCatalogSelect[] = [];
  for (const property of properties) {
    if (property.owner !== "user" || (property.type !== "select" && property.type !== "multi_select")) continue;
    const resolved = resolveProperty(property, database.key, catalogs, manifestLocale);
    selects.push({
      propertyKey: property.key,
      multi: property.type === "multi_select",
      options: (resolved.options ?? []).map(({ key, label }) => ({ key, label })),
    });
  }

  const textKeys = properties
    .filter((property) => property.owner === "user" && property.type === "text")
    .slice(0, MAX_CATALOG_TEXT_PROPERTIES)
    .map((property) => property.key);
  if (textKeys.length === 0 || (await listUnreadableDatabaseIds(client, projectItemId)).has(database.id)) {
    return { selects, textValues: [] };
  }
  const facets = await computeDatabaseFacets(client, database, { facets: textKeys }, metadata, { locale });
  const textValues: TargetCatalogTextValues[] = [];
  for (const facet of facets) {
    if (!("property" in facet)) continue;
    const values = facet.values.flatMap(({ value, count }) =>
      typeof value === "string" && value.length <= MAX_CATALOG_TEXT_VALUE_LENGTH ? [{ value, count }] : [],
    );
    if (values.length > 0)
      textValues.push({ propertyKey: facet.property, values: values.slice(0, MAX_CATALOG_TEXT_VALUES) });
  }
  return { selects, textValues };
}
