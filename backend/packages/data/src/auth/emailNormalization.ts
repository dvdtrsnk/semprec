/** Login attempts and lockout lookups key on this form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
