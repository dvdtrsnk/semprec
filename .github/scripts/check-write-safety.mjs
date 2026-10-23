#!/usr/bin/env node
/**
 * Fails the build when new code under `backend/` introduces one of two write-safety gaps
 * that generic-review found independently on PRs #380 and #386:
 *
 *   1. A `DELETE FROM` / `UPDATE ... SET` whose `pg` result is discarded — no
 *      `requireAffectedRows(result, ...)` call and no `.rowCount` read anywhere after it.
 *      A no-op write then looks identical to a successful one to everything upstream
 *      (`viewItemsStore.removeViewItem` was exactly this before its own local fix).
 *   2. A `pool.connect()` outside `db/pool.ts` itself. Every acquire there should go
 *      through `withClient`/`withTransaction`, whose `finally` guarantees the client is
 *      released even when the caller throws between acquire and its first query
 *      (`syncServer`'s `LISTEN` leak was exactly this).
 *
 * Both helpers live in `backend/packages/data/src/db/pool.ts`.
 *
 * ## Why a baseline, not a hard rule
 *
 * The repository has on the order of 100 instances of shape 1 and 15 of shape 2 today.
 * Most are legitimate — a bulk sweep, a seed, a migration where zero affected rows is a
 * correct outcome, not a bug — and converting them is deliberate follow-up work owned by
 * other threads, not this one. So this script is a *regression* gate: it fails only on a
 * violation that is not already present in `write-safety-baseline.json`, never on the ones
 * already there.
 *
 * ## Why the baseline survives unrelated edits
 *
 * Each violation is identified by its file plus a content hash of its own matched text (the
 * full `.query(...)` call for shape 1, the source line containing `pool.connect()` for shape
 * 2) — never by line number. Adding a line anywhere else in the file, reformatting, or
 * touching an unrelated function never shifts an existing entry out of the baseline, so no
 * unrelated PR is ever forced to regenerate it. The baseline only needs regenerating when
 * someone knowingly adds, removes, or edits one of these call sites:
 *
 *     node .github/scripts/check-write-safety.mjs --update-baseline
 *
 * then review and commit the resulting diff to `write-safety-baseline.json` — a shrinking
 * diff is a conversion onto the new helpers; a growing one should be justified in the PR the
 * way any new instance of either pattern would be.
 *
 * ## Heuristic, not an AST
 *
 * Detection is text-based, in the same spirit as `check-review-scope.mjs`: it scans for
 * `<anything>.query(...)` calls (balancing parens/quotes/backticks by hand, so a paren or
 * quote inside the SQL text or a `${...}` interpolation never desyncs the count) and
 * classifies how the result is used from the few hundred characters around the call — a
 * wrapping `requireAffectedRows(`, a `const`/`let` capture later read as `.rowCount`, or a
 * bare `await` whose result is discarded outright. Shape 2 relies on this codebase's one
 * existing convention of naming the `pg` `Pool` parameter `pool` — a `pool.connect()` call is
 * flagged regardless of what class or function it's in. Both are approximations that can miss
 * an unusually-shaped call site or flag a safe one; the baseline exists precisely so a false
 * positive is a one-time entry here, not a recurring build failure.
 *
 * Test files (`__tests__/` directories, `*.test.ts` — which also covers `*.unit.test.ts` and
 * `*.e2e.test.ts`) are excluded from both shapes: they hold direct `pg` client acquisitions
 * and unchecked mutations as ordinary fixture/assertion code, not the production write path
 * this check exists to guard.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const backendRoot = path.join(repoRoot, "backend");
const poolFile = path.resolve(backendRoot, "packages/data/src/db/pool.ts");
const baselinePath = path.join(scriptDir, "write-safety-baseline.json");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function listTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      listTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(relPath) {
  return relPath.endsWith(".test.ts") || relPath.split(path.sep).includes("__tests__");
}

/** Finds the index of the `)` matching the `(` at `openIdx`, treating quoted/backtick text as opaque so a paren inside SQL or a template interpolation never desyncs the depth count. */
function matchParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every `<receiver>.methodName(...)` call in `text`, receiver-agnostic (`pool`, `client`, `this.tx`, ...). */
function findCalls(text, methodName) {
  const calls = [];
  const re = new RegExp(`\\.${methodName}\\s*(?:<[^>(]*>)?\\s*\\(`, "g");
  let m;
  while ((m = re.exec(text))) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchParen(text, openIdx);
    if (closeIdx === -1) {
      re.lastIndex = openIdx + 1;
      continue;
    }
    let exprStart = m.index;
    while (exprStart > 0 && /[\w$.]/.test(text[exprStart - 1])) exprStart -= 1;
    calls.push({ exprStart, openIdx, closeIdx });
    re.lastIndex = closeIdx + 1;
  }
  return calls;
}

const DELETE_RE = /delete\s+from/i;
const UPDATE_SET_RE = /update\s+\S+\s+set/i;

/** How the call starting at `exprStart` is consumed: wrapped directly, captured into a name/pattern, discarded bare, or an unrecognized shape. */
function classifyCapture(text, exprStart) {
  const WINDOW = 300;
  const prefix = text.slice(Math.max(0, exprStart - WINDOW), exprStart);
  const noAwait = prefix.replace(/await\s*$/, "");
  if (/requireAffectedRows\s*\(\s*$/.test(noAwait)) return { wrapped: true };
  const assign = noAwait.match(/(?:const|let)\s+(\{[^{}]*\}|[A-Za-z_$][\w$]*)\s*=\s*$/);
  if (assign) return { captured: assign[1] };
  const trimmed = noAwait.replace(/\s+$/, "");
  const lastChar = trimmed.slice(-1);
  if (lastChar === "" || lastChar === ";" || lastChar === "{" || lastChar === "}") return { bare: true };
  return { captured: null };
}

/** Whether the captured result is actually read as `.rowCount` (or passed to `requireAffectedRows`) somewhere after the call. */
function usageFollows(text, closeIdx, captured) {
  const WINDOW = 600;
  const suffix = text.slice(closeIdx, Math.min(text.length, closeIdx + WINDOW));
  if (captured === null) return /requireAffectedRows\s*\(|\.rowCount\b/.test(suffix);
  if (captured.startsWith("{")) return /\browCount\b/.test(captured);
  const name = captured.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\b${name}\\s*\\.\\s*rowCount\\b`).test(suffix) ||
    new RegExp(`requireAffectedRows\\s*\\(\\s*${name}\\b`).test(suffix)
  );
}

function normalize(s) {
  return s.replace(/\s+/g, " ").trim();
}

function lineOf(text, idx) {
  return text.slice(0, idx).split("\n").length;
}

function toFingerprint(relFile, snippet) {
  const hash = createHash("sha1").update(normalize(snippet)).digest("hex").slice(0, 12);
  return { key: `${relFile}::${hash}`, snippet: normalize(snippet).slice(0, 100) };
}

/** Appends `#n` to duplicate keys (two call sites with byte-identical matched text in the same file) so the baseline set stays one-to-one with actual violations. */
function dedupe(entries) {
  const counts = new Map();
  return entries.map((e) => {
    const n = counts.get(e.key) ?? 0;
    counts.set(e.key, n + 1);
    return n === 0 ? e : { ...e, key: `${e.key}#${n}` };
  });
}

function scanUnsafeWrites(files) {
  const found = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const relFile = path.relative(backendRoot, file).split(path.sep).join("/");
    for (const call of findCalls(text, "query")) {
      const callText = text.slice(call.openIdx, call.closeIdx + 1);
      if (!DELETE_RE.test(callText) && !UPDATE_SET_RE.test(callText)) continue;

      const classification = classifyCapture(text, call.exprStart);
      const safe =
        classification.wrapped === true
          ? true
          : classification.bare === true
            ? false
            : usageFollows(text, call.closeIdx, classification.captured ?? null);
      if (safe) continue;

      const fp = toFingerprint(relFile, callText);
      found.push({ key: fp.key, file: relFile, line: lineOf(text, call.exprStart), snippet: fp.snippet });
    }
  }
  return dedupe(found);
}

function scanLeakedConnects(files) {
  const found = [];
  const re = /\bpool\s*\.\s*connect\s*\(\s*\)/g;
  for (const file of files) {
    if (path.resolve(file) === poolFile) continue;
    const text = readFileSync(file, "utf8");
    const relFile = path.relative(backendRoot, file).split(path.sep).join("/");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEndIdx = text.indexOf("\n", m.index);
      const contextLine = text.slice(lineStart, lineEndIdx === -1 ? text.length : lineEndIdx);
      const fp = toFingerprint(relFile, contextLine);
      found.push({ key: fp.key, file: relFile, line: lineOf(text, m.index), snippet: fp.snippet });
    }
  }
  return dedupe(found);
}

const allFiles = listTsFiles(backendRoot).filter((f) => !isTestFile(path.relative(backendRoot, f)));
const unsafeWrites = scanUnsafeWrites(allFiles);
const leakedConnects = scanLeakedConnects(allFiles);

if (process.argv.includes("--update-baseline")) {
  const baseline = {
    unsafeWrites: unsafeWrites.map((e) => e.key).sort(),
    leakedConnects: leakedConnects.map((e) => e.key).sort(),
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `Wrote ${baseline.unsafeWrites.length} unsafe-write and ${baseline.leakedConnects.length} leaked-connect ` +
      `fingerprint(s) to ${path.relative(repoRoot, baselinePath)}.`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch (err) {
  console.error(`Could not read baseline at ${path.relative(repoRoot, baselinePath)}: ${err.message}`);
  process.exit(1);
}
const baselineUnsafe = new Set(baseline.unsafeWrites ?? []);
const baselineConnects = new Set(baseline.leakedConnects ?? []);

const newUnsafe = unsafeWrites.filter((e) => !baselineUnsafe.has(e.key));
const newConnects = leakedConnects.filter((e) => !baselineConnects.has(e.key));

if (newUnsafe.length === 0 && newConnects.length === 0) {
  console.log(
    `write-safety: ok (${unsafeWrites.length} unsafe write(s) and ${leakedConnects.length} leaked-connect ` +
      `call(s), all already in the baseline).`,
  );
  process.exit(0);
}

if (newUnsafe.length > 0) {
  console.error(
    `Found ${newUnsafe.length} new DELETE/UPDATE call(s) whose result is never checked ` +
      `(no requireAffectedRows, no rowCount read):`,
  );
  for (const e of newUnsafe) console.error(`  ${e.file}:${e.line}  ${e.snippet}`);
  console.error(
    `Fix: wrap the result in requireAffectedRows(result, "context") (backend/packages/data/src/db/pool.ts), ` +
      `or read result.rowCount yourself if a zero-row outcome is valid here.\n`,
  );
}
if (newConnects.length > 0) {
  console.error(`Found ${newConnects.length} new pool.connect() call(s) outside db/pool.ts:`);
  for (const e of newConnects) console.error(`  ${e.file}:${e.line}  ${e.snippet}`);
  console.error(
    `Fix: use withClient(pool, fn) (backend/packages/data/src/db/pool.ts) instead, so a throw between ` +
      `acquire and release cannot leak the connection.\n`,
  );
}
console.error(
  `If this is a knowingly legitimate instance (a bulk sweep, a seed, a migration where zero rows is a valid ` +
    `outcome), rerun with --update-baseline and commit the updated ${path.relative(repoRoot, baselinePath)}.`,
);
process.exit(1);
