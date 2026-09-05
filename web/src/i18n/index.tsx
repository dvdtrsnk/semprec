import { createContext, useContext, useMemo, type ReactNode } from "react";
import { CATALOGS, DEFAULT_LOCALE, en, type Locale, type MessageKey } from "./messages.js";

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

export function createTranslate(locale: Locale): Translate {
  const catalog = CATALOGS[locale];
  // `en` is the fallback catalog, so a key added to `en` but not yet translated still
  // renders its English text instead of the raw key.
  return (key, values) => interpolate(catalog[key] ?? en[key], values);
}

/** Picks the best supported locale for a browser language list, falling back to Czech. */
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base && base in CATALOGS) return base as Locale;
  }
  return DEFAULT_LOCALE;
}

const I18nContext = createContext<Translate>(createTranslate(DEFAULT_LOCALE));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const translate = useMemo(() => createTranslate(locale), [locale]);
  return <I18nContext.Provider value={translate}>{children}</I18nContext.Provider>;
}

export function useTranslate(): Translate {
  return useContext(I18nContext);
}

export type { Locale, MessageKey };
