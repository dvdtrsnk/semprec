/** Case and whitespace are not meaningful in an email address's local/domain parts for our purposes, so login attempts and lockout lookups key on this normalized form rather than the caller-supplied one. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
