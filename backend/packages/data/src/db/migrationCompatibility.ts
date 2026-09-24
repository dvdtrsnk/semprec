/**
 * Mechanical half of `docs/adr/2026-09-10-expand-contract-forward-only-migrations.md`: flags the
 * statements that would break the previous release's code, which keeps running against the
 * migrated schema both while a deploy migrates and after `deploy.sh --rollback` (issue #191).
 *
 * It is a lexical check, not a SQL parser. Comments and string literals are blanked out first, so
 * a word in a comment or inside `EXECUTE '...'` is never flagged; statements inside a `DO $$ ... $$`
 * body are checked like top-level ones. A statement against a table an earlier statement of the same
 * file creates is never flagged, since no previous release can use that table; a table dropped before
 * the file (re)creates it is still the previous release's table and is flagged.
 *
 * A file whose change is safe for a reason a lexical check cannot see opts out with a line comment
 * `-- expand-contract-exemption: <reason>`: a contract step (the removal half of expand/contract,
 * shipped once no release that can still run uses the old shape), a type change that only widens,
 * or a breaking change the linked issue's Task explicitly calls for.
 */

export type MigrationCompatibilityRule =
  "dropTable" | "dropColumn" | "rename" | "changeColumnType" | "setNotNull" | "addRequiredColumn";

export interface MigrationCompatibilityFinding {
  rule: MigrationCompatibilityRule;
  statement: string;
}

const EXEMPTION_MARKER = /^--[ \t]*expand-contract-exemption:[ \t]*\S/;

/**
 * Replaces comments with a space and string-literal contents with nothing, keeping the quotes, and
 * returns the line comments it removed.
 */
function blankCommentsAndStrings(sql: string): { code: string; lineComments: string[] } {
  const lineComments: string[] = [];
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      lineComments.push(sql.slice(i, stop));
      i = stop;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      out += "''";
    } else {
      out += ch;
      i += 1;
    }
  }
  return { code: out, lineComments };
}

function normalizeName(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

/** Splits on commas outside parentheses, so a column's `CHECK (a, b)` stays in one clause. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// Every capture group below is mandatory, so a match always has it; `?? ""` only satisfies the type.
const NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)`;
const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  "gi",
);
const ALTER_TABLE = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}\s+([\s\S]*)$`, "i");
const DROP_TABLE = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]*?)(?:\s+(?:CASCADE|RESTRICT))?\s*$/i;
const ALTER_OTHER_RENAME = /\bALTER\s+(?!TABLE\b)[\s\S]*\bRENAME\b/i;

function classifyAlterTableClause(clause: string): MigrationCompatibilityRule | null {
  if (/^RENAME\b/i.test(clause)) return "rename";
  if (/^DROP\s+(?!CONSTRAINT\b)/i.test(clause)) return "dropColumn";
  if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(clause)) return "changeColumnType";
  if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL\b/i.test(clause)) return "setNotNull";
  if (
    /^ADD\s+(?!(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b)/i.test(clause) &&
    /\bNOT\s+NULL\b/i.test(clause) &&
    !/\b(?:DEFAULT|GENERATED|SERIAL|SMALLSERIAL|BIGSERIAL)\b/i.test(clause)
  ) {
    return "addRequiredColumn";
  }
  return null;
}

export function findIncompatibleStatements(sql: string): MigrationCompatibilityFinding[] {
  const { code, lineComments } = blankCommentsAndStrings(sql);
  if (lineComments.some((comment) => EXEMPTION_MARKER.test(comment))) return [];

  const createdTables = new Set<string>();
  const findings: MigrationCompatibilityFinding[] = [];

  for (const rawStatement of code.split(";")) {
    const statement = rawStatement.replace(/\s+/g, " ").trim();
    if (statement.length === 0) continue;

    for (const created of statement.matchAll(CREATE_TABLE)) createdTables.add(normalizeName(created[1] ?? ""));

    const alterTable = ALTER_TABLE.exec(statement);
    if (alterTable) {
      if (createdTables.has(normalizeName(alterTable[1] ?? ""))) continue;
      for (const clause of splitTopLevel(alterTable[2] ?? "")) {
        const rule = classifyAlterTableClause(clause);
        if (rule) findings.push({ rule, statement });
      }
      continue;
    }

    const dropTable = DROP_TABLE.exec(statement);
    if (dropTable) {
      const dropped = splitTopLevel(dropTable[1] ?? "").map(normalizeName);
      if (dropped.some((name) => !createdTables.has(name))) findings.push({ rule: "dropTable", statement });
      continue;
    }

    if (ALTER_OTHER_RENAME.test(statement)) findings.push({ rule: "rename", statement });
  }
  return findings;
}
