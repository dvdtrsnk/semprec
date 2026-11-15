import type { PoolClient } from "pg";
import { listUnreadableDatabaseIds } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { resolveProperty, toManifestLocale } from "../manifest/catalogResolution.js";
import { computeDatabaseFacets, loadFacetMetadata } from "../views/facetQuery.js";

/** At most this many text properties of one database contribute known values (issue gh-1990). */
export const MAX_CATALOG_TEXT_PROPERTIES = 5;

/**
 * At most this many distinct values per text property, the most frequent first (issue gh-1990). It is a bound and not a
 * quota: the facets read cuts to its 20 most frequent values first and a value over `MAX_CATALOG_TEXT_VALUE_LENGTH` is
 * then left out of those, so fewer than 20 are listed when a frequent value is long.
 */
export const MAX_CATALOG_TEXT_VALUES = 20;

/**
 * The longest value the catalog lists, in characters. A longer text is a note and not a value to reuse, so it is
 * left out whole instead of cut: a cut value would be proposed as if it were the stored one.
 */
export const MAX_CATALOG_TEXT_VALUE_LENGTH = 100;

export interface TargetCatalogSelect {
  propertyKey: string;
  /** `true` for a `multi_select` property, whose value is a list of option keys. */
  multi: boolean;
  /** The stored option keys, each with the label the user's language shows for it. */
  options: Array<{ key: string; label: string }>;
}

export interface TargetCatalogTextValues {
  propertyKey: string;
  /** Values already stored in the property, with the number of live items that hold each. */
  values: Array<{ value: string; count: number }>;
}

/** What a proposal into one database may be grounded in: its select options and the values its text properties hold. */
export interface TargetCatalog {
  selects: TargetCatalogSelect[];
  textValues: TargetCatalogTextValues[];
}

/**
 * The catalog of one target database for a proposal (issue gh-1990), read under the caller's tenant transaction;
 * it writes nothing.
 *
 * `selects` lists every user-owned `select` and `multi_select` property in the database's property order with its
 * option keys and the option labels in `locale` (`cs` or, for any other value, `en`), resolved through the owning
 * module's catalog like `GET /api/schema` does. This is schema, so it is returned whatever the reader may read.
 *
 * `textValues` lists, for the first `MAX_CATALOG_TEXT_PROPERTIES` user-owned `text` properties (a `title` property
 * is of another type and never appears), the values already in use with their counts, read through the facets of
 * `database.facets` (`computeDatabaseFacets`): the `MAX_CATALOG_TEXT_VALUES` most frequent, trashed items not counted,
 * values longer than `MAX_CATALOG_TEXT_VALUE_LENGTH` and items without a value left out, a property without any value
 * left out. These are data, so they are read only when the project `projectItemId` may read the database, decided as
 * the workspace context does (`listUnreadableDatabaseIds`, issue #1810); otherwise `textValues` is empty.
 *
 * A database that does not exist for the tenant, whether it is unknown or another tenant's, has an empty catalog.
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
