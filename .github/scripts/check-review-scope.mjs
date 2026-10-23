#!/usr/bin/env node
/**
 * Fails the build when a platform's `review-rules/scope.md` no longer carries usable
 * glob patterns.
 *
 * The review bot reads those files as literal globs and silently skips any file they
 * don't match. Prettier once reformatted them as Markdown — escaping `*` to `\*` and
 * rewriting `*...*` as emphasis — which emptied every backend and web pattern, and the
 * review skipped every file on both platforms for 14 merged pull requests before anyone
 * noticed. A green `code-review` check meant "nothing was reviewed", which is exactly
 * the failure a required check exists to prevent.
 *
 * Structural corruption fails the run. Matching zero files only warns: `apple/` is an
 * empty scaffold whose rules deliberately apply from its first implementation PR onward,
 * and a platform waiting for its first file is a legitimate state.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function findScopeFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "review-rules") {
      const scope = path.join(full, "scope.md");
      try {
        statSync(scope);
        found.push(scope);
      } catch {
        // A review-rules directory without scope.md is not a platform (the repo-root
        // parity config has that shape); the bot ignores it and so do we.
      }
      continue;
    }
    findScopeFiles(full, found);
  }
  return found;
}

/** Patterns under `# Include`, up to the next heading. */
function parseIncludes(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#+\s*include\b/i.test(l.trim()));
  if (start === -1) return null;
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) break;
    if (trimmed) patterns.push(trimmed);
  }
  return patterns;
}

function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` spans any number of directories, including none.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

let failed = false;
const scopeFiles = findScopeFiles(process.cwd()).sort();
if (scopeFiles.length === 0) {
  console.error("No review-rules/scope.md found anywhere — the review bot would review nothing.");
  process.exit(1);
}

for (const scopeFile of scopeFiles) {
  const platformDir = path.relative(process.cwd(), path.dirname(path.dirname(scopeFile))) || ".";
  const label = platformDir === "." ? "root" : platformDir;
  const patterns = parseIncludes(readFileSync(scopeFile, "utf8"));

  if (patterns === null) {
    console.error(`FAIL ${label}: ${scopeFile} has no "# Include" section.`);
    failed = true;
    continue;
  }
  if (patterns.length === 0) {
    console.error(`FAIL ${label}: "# Include" lists no patterns — the bot would skip every file.`);
    failed = true;
    continue;
  }

  const corrupted = patterns.filter((p) => p.includes("\\") || /^_.*_$/.test(p));
  if (corrupted.length > 0) {
    console.error(
      `FAIL ${label}: pattern(s) rewritten as Markdown rather than left as globs: ${corrupted.join(", ")}. ` +
        `Restore the literal glob and keep this file out of the formatter.`,
    );
    failed = true;
    continue;
  }

  const prefix = platformDir === "." ? "" : `${platformDir}/`;
  const candidates = tracked.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  const matchers = patterns.map(globToRegExp);
  const matched = candidates.filter((f) => matchers.some((re) => re.test(f)));

  if (matched.length === 0) {
    console.warn(`warn ${label}: no tracked file matches its include patterns (expected for a platform with no code yet).`);
  } else {
    console.log(`ok   ${label}: ${patterns.length} pattern(s), ${matched.length} tracked file(s) in scope.`);
  }
}

process.exit(failed ? 1 : 0);
