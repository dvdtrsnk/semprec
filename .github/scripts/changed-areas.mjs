#!/usr/bin/env node
/**
 * Decides which platform pipelines a change needs: `backend`, `web`, `android` and `apple`.
 *
 * Usage, from anywhere inside the repository:
 *
 *   node .github/scripts/changed-areas.mjs --base <rev> [--head <rev>] --area <name>
 *     prints `true` or `false`
 *   node .github/scripts/changed-areas.mjs --base <rev> [--head <rev>] --json
 *     prints every area with the paths that put it in
 *   node .github/scripts/changed-areas.mjs --base <rev> [--head <rev>] --github-output
 *     appends `<area>=true|false` lines to the file named by GITHUB_OUTPUT and, when
 *     GITHUB_STEP_SUMMARY is set, a table of the decision to the job summary
 *
 * The change is `git diff --no-renames <merge-base of base and head> <head>`; `--head` defaults
 * to `HEAD`. It compares commits, so uncommitted and untracked files are not part of it. Renames
 * are listed as a deletion and an addition, so a file moved from one area to another counts for
 * both. Each path is classified by the first matching rule in `RULES`; a path
 * no rule names counts for every area.
 *
 * When the comparison cannot be made (an unknown revision, no common ancestor, git missing) every
 * area is `true` and a warning goes to stderr: a failed detection runs more, never less. A usage
 * error exits 2 without printing an area.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isEntryScript } from "./is-entry-script.mjs";

export const AREAS = Object.freeze(["backend", "web", "android", "apple"]);

const ALL = AREAS;
const NONE = Object.freeze([]);

/**
 * Ordered: the first rule whose pattern matches a path decides its areas. A pattern ending in `/`
 * matches everything below that directory; any other pattern matches that exact path.
 */
export const RULES = Object.freeze([
  // Review-bot specifications; `check-review-scope.mjs` in the always-run `ci` job reads them.
  { pattern: "backend/review-rules/", areas: NONE },
  { pattern: "web/review-rules/", areas: NONE },
  { pattern: "mobile/android/review-rules/", areas: NONE },
  { pattern: "mobile/apple/review-rules/", areas: NONE },
  { pattern: "mobile/review-rules/", areas: NONE },
  { pattern: "backend/", areas: ["backend"] },
  // Three backend tests read deployment files.
  { pattern: "deploy/", areas: ["backend"] },
  // `@semprec/block-model`: the backend imports it and its tests run in the backend unit tier. The
  // Kotlin port copies its fixture vectors into its own tests instead of reading the file.
  { pattern: "shared/", areas: ["backend"] },
  { pattern: "web/", areas: ["web"] },
  { pattern: "mobile/android/", areas: ["android"] },
  { pattern: "mobile/apple/", areas: ["apple"] },
  // Shared Kotlin, the Gradle build, verify scripts and mobile docs feed both apps.
  { pattern: "mobile/", areas: ["android", "apple"] },
  // Both workspaces' format checks read the root Prettier files.
  { pattern: ".prettierignore", areas: ["backend", "web"] },
  { pattern: ".prettierrc.json", areas: ["backend", "web"] },
  // This detector decides what runs, so a change to it runs everything.
  { pattern: ".github/scripts/changed-areas.mjs", areas: ALL },
  { pattern: ".github/scripts/check-write-safety.mjs", areas: ["backend"] },
  { pattern: ".github/scripts/write-safety-baseline.json", areas: ["backend"] },
  // The `ci` job runs every repository-script test and catalog check on every change.
  { pattern: ".github/scripts/", areas: NONE },
  { pattern: ".github/ISSUE_FORMAT.md", areas: NONE },
  { pattern: ".github/", areas: ALL },
  { pattern: "docs/", areas: NONE },
  { pattern: "issues/", areas: NONE },
  { pattern: "review-rules/", areas: NONE },
  { pattern: ".bb/", areas: NONE },
  { pattern: ".claude/", areas: NONE },
  { pattern: ".relay/", areas: NONE },
  // Brand sources; no build or test reads them.
  { pattern: "assets/", areas: NONE },
  { pattern: "README.md", areas: NONE },
]);

function ruleFor(path) {
  return RULES.find(({ pattern }) => (pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern));
}

/** Maps each area to the changed paths that put it in; an area no path needs maps to an empty list. */
export function classifyPaths(paths) {
  const result = Object.fromEntries(AREAS.map((area) => [area, []]));
  for (const path of paths) {
    const areas = ruleFor(path)?.areas ?? ALL;
    for (const area of areas) result[area].push(path);
  }
  return result;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The paths changed between the merge base of `base` and `head`, and `head`. Returns `null`, with
 * the reason, when git cannot make the comparison.
 */
export function changedPaths({ base, head = "HEAD", cwd = process.cwd() }) {
  try {
    const mergeBase = git(["merge-base", base, head], cwd).trim();
    const listing = git(["diff", "--no-renames", "--name-only", "-z", mergeBase, head], cwd);
    return { paths: listing.split("\0").filter((path) => path !== ""), error: null };
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : String(error);
    return { paths: null, error: `cannot compare ${base}...${head}: ${detail}` };
  }
}

/** Every area `true` when the comparison failed; otherwise the classification of the changed paths. */
export function decideAreas(comparison) {
  if (comparison.paths === null) {
    return { areas: Object.fromEntries(AREAS.map((area) => [area, true])), byArea: null, warning: comparison.error };
  }
  const byArea = classifyPaths(comparison.paths);
  return { areas: Object.fromEntries(AREAS.map((area) => [area, byArea[area].length > 0])), byArea, warning: null };
}

export function parseArguments(argv) {
  const options = { base: null, head: "HEAD", mode: null, area: null };
  const setMode = (mode) => {
    if (options.mode !== null) throw new Error("choose exactly one of --area, --json and --github-output");
    options.mode = mode;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === "--base") options.base = value();
    else if (argument === "--head") options.head = value();
    else if (argument === "--area") {
      setMode("area");
      options.area = value();
      if (!AREAS.includes(options.area)) throw new Error(`unknown area ${JSON.stringify(options.area)}; expected one of ${AREAS.join(", ")}`);
    } else if (argument === "--json") setMode("json");
    else if (argument === "--github-output") setMode("github-output");
    else throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (options.base === null) throw new Error("--base is required");
  if (options.mode === null) throw new Error("choose exactly one of --area, --json and --github-output");
  return options;
}

function summaryTable(decision) {
  const lines = ["| Area | Runs | Because of |", "| --- | --- | --- |"];
  for (const area of AREAS) {
    const paths = decision.byArea?.[area] ?? [];
    const because = decision.byArea === null ? "detection failed, so everything runs" : paths.slice(0, 5).map((path) => `\`${path}\``).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");
    lines.push(`| ${area} | ${decision.areas[area] ? "yes" : "no"} | ${because} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  const options = parseArguments(argv);
  const decision = decideAreas(changedPaths({ base: options.base, head: options.head, cwd }));
  if (decision.warning !== null) console.error(`changed-areas: ${decision.warning}; treating every area as changed`);
  if (options.mode === "area") {
    console.log(String(decision.areas[options.area]));
  } else if (options.mode === "json") {
    console.log(JSON.stringify({ areas: decision.areas, paths: decision.byArea, warning: decision.warning }, null, 2));
  } else {
    if (!env.GITHUB_OUTPUT) throw new Error("--github-output needs GITHUB_OUTPUT");
    appendFileSync(env.GITHUB_OUTPUT, AREAS.map((area) => `${area}=${decision.areas[area]}\n`).join(""));
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryTable(decision));
    console.log(AREAS.map((area) => `${area}=${decision.areas[area]}`).join(" "));
  }
  return decision;
}

if (isEntryScript(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(`changed-areas: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
