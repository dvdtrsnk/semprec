import { resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";

/** Names a resolution title can carry; a name that is absent or blank is written as the catalog's neutral word. */
export type ResolutionTitleParams = {
  mailbox?: string | null;
  title?: string | null;
  name?: string | null;
  project?: string | null;
  database?: string | null;
  /** The `kind` of the guidance drift finding the problem refers to; `behavior` selects the behavioral title. */
  findingKind?: string | null;
};

const UNNAMED_KEY = "status.resolved.unnamed";
const UNKNOWN_KEY = "status.resolved.unknown";

function catalogKey(kind: string, resolutionKind: string, params: ResolutionTitleParams): string {
  const titleKind = kind === "guidanceDrift" && params.findingKind === "behavior" ? "guidanceDriftBehavior" : kind;
  return `status.resolved.${resolutionKind}.${titleKind}`;
}

/**
 * Resolution title from `status.resolved.<resolutionKind>.<kind>`, falling back to `status.resolved.unknown`.
 * A missing name is replaced by `status.resolved.unnamed` so the title never has a gap.
 */
export function renderResolutionTitle(
  catalogs: ModuleCatalogs,
  kind: string,
  resolutionKind: string,
  params: ResolutionTitleParams,
  locale: "cs" | "en",
): string {
  const label = (key: string) => resolveCatalogLabel(undefined, catalogs[locale], catalogs.en, key);
  const specific = catalogKey(kind, resolutionKind, params);
  const template = label(catalogs.en[specific] === undefined ? UNKNOWN_KEY : specific);
  const unnamed = label(UNNAMED_KEY);
  const values: Readonly<Record<string, string | null | undefined>> = params;
  return template
    .replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      const clean = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      return clean === "" ? unnamed : clean;
    })
    .trim();
}
