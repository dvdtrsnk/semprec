import { useAuthenticatedWebContext } from "../authenticatedWebContext.js";
import cs from "./cs.json";
import en from "./en.json";

type Catalog = Record<string, string>;

const catalogs: Record<string, Catalog> = { cs, en };
const englishCatalog: Catalog = en;

export function resolveLocalizedString(locale: string, key: string): string {
  return catalogs[locale]?.[key] ?? englishCatalog[key] ?? key;
}

/** Resolves static UI copy using the locale of the authenticated user. */
export function useLocalizedString(): (key: string) => string {
  const { user } = useAuthenticatedWebContext();
  return (key) => resolveLocalizedString(user.locale, key);
}
