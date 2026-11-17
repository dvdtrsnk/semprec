/** One foreign key between two tables: `table` holds the referencing column, `referencedTable` the parent. */
export interface TableForeignKey {
  table: string;
  referencedTable: string;
}

/**
 * Orders `tables` children first, so deleting in order never removes a parent a child still references.
 * Foreign keys to tables outside the set and self-references are ignored (such a table is deleted in one
 * statement). Any other cycle throws naming every unordered table. Ties break alphabetically.
 */
export function orderTablesForPurge(tables: readonly string[], foreignKeys: readonly TableForeignKey[]): string[] {
  const known = new Set(tables);
  // parent -> the distinct child tables that must be deleted before it.
  const pendingChildren = new Map<string, Set<string>>();
  // child -> the parents that stop waiting for it once it is deleted.
  const parentsOf = new Map<string, Set<string>>();
  for (const name of known) {
    pendingChildren.set(name, new Set());
    parentsOf.set(name, new Set());
  }
  for (const { table, referencedTable } of foreignKeys) {
    if (table === referencedTable || !known.has(table) || !known.has(referencedTable)) continue;
    pendingChildren.get(referencedTable)?.add(table);
    parentsOf.get(table)?.add(referencedTable);
  }

  const ordered: string[] = [];
  const ready = [...known].filter((name) => pendingChildren.get(name)?.size === 0).sort();
  while (ready.length > 0) {
    const name = ready.shift();
    if (name === undefined) break;
    ordered.push(name);
    for (const parent of parentsOf.get(name) ?? []) {
      const waiting = pendingChildren.get(parent);
      waiting?.delete(name);
      if (waiting?.size === 0) {
        ready.push(parent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== known.size) {
    const done = new Set(ordered);
    const stuck = [...known].filter((name) => !done.has(name)).sort();
    throw new Error(`Foreign keys form a cycle; tables on or behind it: ${stuck.join(", ")}`);
  }
  return ordered;
}
