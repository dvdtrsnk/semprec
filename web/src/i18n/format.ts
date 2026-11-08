import type { Locale } from "./messages.js";

export function formatDateTime(locale: Locale, iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

export function formatUsd(locale: Locale, amount: number): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);
}
