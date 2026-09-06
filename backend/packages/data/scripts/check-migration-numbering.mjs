#!/usr/bin/env node
// Fails CI when two migration files share the same leading ordinal (e.g. two
// branches both picking 0011_*.sql independently). The migration runner keys
// applied migrations by full filename, so a collision like this never fails
// at the database layer or as a git merge conflict — it silently applies
// both files in alphabetical order. This check is the only thing that
// catches it, before it ships.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

const byOrdinal = new Map();
for (const file of files) {
  const match = file.match(/^(\d+)_/);
  if (!match) {
    console.error(`Migration file does not start with a numeric ordinal: ${file}`);
    process.exitCode = 1;
    continue;
  }
  const ordinal = match[1];
  const existing = byOrdinal.get(ordinal) ?? [];
  existing.push(file);
  byOrdinal.set(ordinal, existing);
}

for (const [ordinal, group] of byOrdinal) {
  if (group.length > 1) {
    console.error(`Migration ordinal ${ordinal} is used by more than one file: ${group.join(", ")}`);
    console.error(`Rename one of them to the next free ordinal (currently highest: ${[...byOrdinal.keys()].sort((a, b) => Number(a) - Number(b)).at(-1)}).`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log(`${files.length} migration file(s), all with unique ordinals.`);
