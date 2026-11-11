/** The languages a user can choose for the application; the chosen one is stored in `users.locale` (issue #1704). */
export const SUPPORTED_LOCALES = ["cs", "en"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Whether `value` is one of `SUPPORTED_LOCALES`. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
