/** Normalize a phone number to international digits using the Czech default country code. */
export function normalizeSearchPhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  return `420${digits}`;
}
