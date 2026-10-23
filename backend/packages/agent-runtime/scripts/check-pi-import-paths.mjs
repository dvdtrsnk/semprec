#!/usr/bin/env node
// Fails CI when source reaches into an internal or example path of the pinned pi
// packages (e.g. `@earendil-works/pi-coding-agent/dist/core/...` or an `examples/`
// snippet) instead of the packages' documented public entry points. pi has not
// published stable internal APIs, so an internal import can break on any pi patch
// release without a version bump surfacing it.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const ALLOWED_SPECIFIERS = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
]);

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\(\s*)["'](@earendil-works\/pi-[^"']*)["']/g;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
for (const file of walk(srcDir)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (!ALLOWED_SPECIFIERS.has(specifier)) {
      violations.push(`${path.relative(srcDir, file)}: imports internal/example pi path "${specifier}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("Found imports reaching into internal/example pi package paths:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\nOnly these package roots may be imported: ${[...ALLOWED_SPECIFIERS].join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("pi import paths: OK — only documented package roots are imported.");
}
