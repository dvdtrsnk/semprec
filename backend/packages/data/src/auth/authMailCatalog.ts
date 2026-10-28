import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";

export type AuthMailKind = "passwordReset" | "invite";

export interface RenderedAuthMail {
  subject: string;
  text: string;
  html: string;
}

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached, so the next send retries. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/**
 * Renders a transactional auth email in the recipient's language. `locale` is an untrusted stored
 * value: anything other than `cs` renders English. `escapeHtml` is applied to the URL in the html
 * template only; the text template receives the URL verbatim.
 */
export async function renderAuthMail(
  kind: AuthMailKind,
  locale: string,
  url: string,
  escapeHtml: (value: string) => string,
): Promise<RenderedAuthMail> {
  const catalogs = await getCatalogs();
  const resolve = (part: "subject" | "text" | "html"): string =>
    resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, `mail.${kind}.${part}`);
  // A replacer function keeps `$` sequences in the URL literal.
  const fill = (template: string, value: string): string => template.replaceAll("{url}", () => value);
  return {
    subject: resolve("subject"),
    text: fill(resolve("text"), url),
    html: fill(resolve("html"), escapeHtml(url)),
  };
}
