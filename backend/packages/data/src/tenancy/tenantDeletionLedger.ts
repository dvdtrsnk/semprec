const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parses the backup's `tenant-deletions.ledger`: one lowercase tenant uuid per line, blank lines ignored,
 * duplicates collapsed in first-seen order. Any other line throws naming only its 1-based line number, so
 * a malformed file is refused before an id reaches SQL.
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
