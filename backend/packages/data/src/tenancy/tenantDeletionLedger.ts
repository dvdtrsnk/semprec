const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parses the `tenant-deletions.ledger` file the backup writes into each snapshot: one lowercase
 * tenant uuid per line. Blank lines are ignored and repeated ids collapse to one, keeping first-seen
 * order. Any other line throws an error that names its 1-based line number and nothing of its
 * content, so a malformed file is refused before any id reaches SQL.
 */
export function parseTenantDeletionLedger(text: string): string[] {
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    if (!UUID_PATTERN.test(line)) {
      throw new Error(`Tenant deletion ledger line ${index + 1} is not a lowercase uuid`);
    }
    ids.add(line);
  }
  return [...ids];
}
