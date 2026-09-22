#!/usr/bin/env node
/**
 * Fails the build when a pull request authored by the Relay GitHub App changes one of
 * the paths Relay itself is never allowed to touch: `.relay/**` (its own workflows and
 * config), `.github/workflows/**` (the CI and review pipelines that gate its work) and
 * this script.
 *
 * Relay enforces the same rule on its own side (`protected-paths` in `.relay/config.yml`,
 * checked by its `guard-paths` step before anything is pushed). This script is the
 * GitHub-enforced half: it does not trust the Relay worker to have run its guard, and it
 * catches a change that reached the pull request by any other route — a fix round, a
 * rebase, a manual push to a Relay branch under the App's identity.
 *
 * It runs from `.github/workflows/protected-paths.yml` on `pull_request_target`, so the
 * copy that runs is always the base branch's: a pull request that edits this file, or
 * the workflow, changes nothing about how it is checked. It must never check the pull
 * request's tree out or run anything from it — the API listing below is all it needs.
 *
 * Human pull requests are unaffected: the script only looks at the files of a pull
 * request whose author is the Relay App's bot user (`RELAY_BOT_LOGIN`, default
 * `bb-agent-relay[bot]` — the `user.login` GitHub reports on the App's pull requests
 * here). Any other event (a push, a manual dispatch) passes without an API call.
 *
 * Inputs, all from the Actions runner environment:
 *   GITHUB_EVENT_NAME / GITHUB_EVENT_PATH  — the event and its payload (number, author)
 *   GITHUB_REPOSITORY, GITHUB_API_URL     — where to list the pull request's files
 *   GITHUB_TOKEN                           — needs `pull-requests: read`
 *   RELAY_BOT_LOGIN                        — override the App's bot login
 *
 * The changed-file list comes from the pull request API, paginated, not from the
 * checkout: on `pull_request` events the workspace holds the merge ref, whose diff
 * against the base can differ from what the pull request itself declares. A rename
 * counts on both of its names, so moving a workflow out of `.github/workflows/` is a
 * change to a protected path too.
 *
 * `--self-test` exercises the decision logic and the paginated listing against fixtures,
 * with no network and no runner environment, and exits non-zero on the first failed
 * expectation. CI runs it right before the real check so a regression in this script
 * fails loudly instead of silently passing every pull request.
 */
import { readFileSync } from "node:fs";

const DEFAULT_RELAY_BOT_LOGIN = "bb-agent-relay[bot]";

/**
 * Deliberately hardcoded rather than read from `.relay/config.yml`: a config read from
 * a checkout could be edited by the very pull request this check exists to catch. The
 * script itself is on the list so that Relay cannot weaken it and have a human merge
 * that unnoticed. Keep this list in step with `protected-paths` in `.relay/config.yml`.
 */
const PROTECTED_PATTERNS = [".relay/**", ".github/workflows/**", ".github/scripts/check-protected-paths.mjs"];

const PER_PAGE = 100;

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

const PROTECTED_MATCHERS = PROTECTED_PATTERNS.map(globToRegExp);

export function isProtectedPath(path) {
  return PROTECTED_MATCHERS.some((re) => re.test(path));
}

/**
 * Whether the pull request author is the Relay App. GitHub reports an App's user as
 * `<slug>[bot]`; the suffix check is a guard against `RELAY_BOT_LOGIN` being set to a
 * human login by mistake, which would turn this into a block on that person's PRs.
 */
export function isRelayBot(login, relayBotLogin = DEFAULT_RELAY_BOT_LOGIN) {
  return typeof login === "string" && login.endsWith("[bot]") && login === relayBotLogin;
}

/**
 * The pure decision. `files` is the pull request's file list as the API returns it
 * (`filename`, optional `previous_filename` on a rename); only read when the author
 * is the Relay App, so it may be a function that lists lazily.
 *
 * Returns `{ outcome: "skip" | "pass" | "fail", reason, violations }`.
 */
export async function decide({ eventName, author, relayBotLogin = DEFAULT_RELAY_BOT_LOGIN, files }) {
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    return { outcome: "skip", reason: `event "${eventName}" is not a pull request; nothing to check`, violations: [] };
  }
  if (!isRelayBot(author, relayBotLogin)) {
    return { outcome: "pass", reason: `author "${author}" is not the Relay App (${relayBotLogin}); human pull requests are not restricted`, violations: [] };
  }
  const list = typeof files === "function" ? await files() : files;
  const touched = new Set();
  for (const file of list) {
    if (typeof file.filename === "string") touched.add(file.filename);
    if (typeof file.previous_filename === "string") touched.add(file.previous_filename);
  }
  const violations = [...touched].filter(isProtectedPath).sort();
  if (violations.length > 0) {
    return { outcome: "fail", reason: `pull request by ${author} changes ${violations.length} protected path(s)`, violations };
  }
  return { outcome: "pass", reason: `pull request by ${author} changes no protected path (${touched.size} file(s) checked)`, violations: [] };
}

/** Next page URL from a `Link: <url>; rel="next"` header, or null. */
export function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Every file of the pull request, following `Link: rel="next"` until the API stops
 * returning one. Throws on a non-2xx response — a listing that could not be completed
 * is a failed check, never an empty one.
 */
export async function listPullRequestFiles({ apiUrl, repository, number, token, fetchImpl = fetch }) {
  const files = [];
  let url = `${apiUrl.replace(/\/+$/, "")}/repos/${repository}/pulls/${number}/files?per_page=${PER_PAGE}`;
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > 100) throw new Error(`gave up after ${pages - 1} pages of files for #${number}`);
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`GET ${url} -> expected a JSON array of files`);
    files.push(...page);
    url = nextLink(response.headers.get("link"));
  }
  return files;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const relayBotLogin = process.env.RELAY_BOT_LOGIN || DEFAULT_RELAY_BOT_LOGIN;

  let author = "";
  let number = 0;
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const event = JSON.parse(readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8"));
    const pr = event && typeof event === "object" ? event.pull_request : undefined;
    if (!pr || typeof pr.number !== "number" || !pr.user || typeof pr.user.login !== "string") {
      throw new Error("the event payload carries no pull_request.number / pull_request.user.login");
    }
    author = pr.user.login;
    number = pr.number;
  }

  const result = await decide({
    eventName,
    author,
    relayBotLogin,
    files: () =>
      listPullRequestFiles({
        apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
        repository: requireEnv("GITHUB_REPOSITORY"),
        number,
        token: requireEnv("GITHUB_TOKEN"),
      }),
  });

  if (result.outcome === "fail") {
    for (const path of result.violations) {
      console.error(`::error file=${path}::Relay may not change ${path}: it matches a protected path (${PROTECTED_PATTERNS.join(", ")}).`);
    }
    console.error(`FAIL ${result.reason}. Changes under ${PROTECTED_PATTERNS.join(" or ")} must come from a human pull request.`);
    process.exit(1);
  }
  console.log(`${result.outcome === "skip" ? "skip" : "ok  "} ${result.reason}.`);
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

async function selfTest() {
  const { strict: assert } = await import("node:assert");
  const BOT = DEFAULT_RELAY_BOT_LOGIN;
  const trap = () => {
    throw new Error("files must not be listed for this case");
  };

  // Non-PR events pass without touching the API.
  assert.equal((await decide({ eventName: "push", author: "", files: trap })).outcome, "skip");
  assert.equal((await decide({ eventName: "workflow_dispatch", author: "", files: trap })).outcome, "skip");

  // Human pull requests pass regardless of what they change, without listing files.
  assert.equal((await decide({ eventName: "pull_request", author: "dvdtrsnk", files: trap })).outcome, "pass");

  // Another App's bot is not Relay; a human login configured as the bot is ignored.
  assert.equal((await decide({ eventName: "pull_request", author: "dependabot[bot]", files: trap })).outcome, "pass");
  assert.equal(isRelayBot("dvdtrsnk", "dvdtrsnk"), false);
  assert.equal(isRelayBot(BOT), true);
  assert.equal(isRelayBot("other-relay[bot]", "other-relay[bot]"), true);

  // Relay changing ordinary paths passes; the file list is consulted.
  const ordinary = [{ filename: "backend/packages/data/src/db/pool.ts" }, { filename: "docs/adr/2026-09-21-something.md" }];
  const okResult = await decide({ eventName: "pull_request", author: BOT, files: ordinary });
  assert.equal(okResult.outcome, "pass");
  assert.deepEqual(okResult.violations, []);

  // Relay changing a protected path fails and names every offending file — on either event name.
  const offending = [
    { filename: "backend/src/x.ts" },
    { filename: ".relay/config.yml" },
    { filename: ".relay/workflows/implement-issue.md" },
    { filename: ".github/workflows/ci.yml" },
    { filename: ".github/scripts/check-protected-paths.mjs" },
  ];
  const failResult = await decide({ eventName: "pull_request_target", author: BOT, files: offending });
  assert.equal(failResult.outcome, "fail");
  assert.deepEqual(failResult.violations, [".github/scripts/check-protected-paths.mjs", ".github/workflows/ci.yml", ".relay/config.yml", ".relay/workflows/implement-issue.md"]);

  // A rename out of a protected directory counts through `previous_filename`.
  const renamed = [{ filename: "ci.yml", previous_filename: ".github/workflows/ci.yml", status: "renamed" }];
  assert.equal((await decide({ eventName: "pull_request", author: BOT, files: renamed })).outcome, "fail");

  // This script protects itself; the other scripts and a top-level file named like a protected dir are not protected.
  assert.equal(isProtectedPath(".github/scripts/check-protected-paths.mjs"), true);
  assert.equal(isProtectedPath(".github/scripts/check-review-scope.mjs"), false);
  assert.equal(isProtectedPath(".relay"), false);
  assert.equal(isProtectedPath("foo/.relay/config.yml"), false);
  assert.equal(isProtectedPath(".relay/workflows/x.md"), true);
  assert.equal(isProtectedPath(".github/workflows/nested/x.yml"), true);

  // RELAY_BOT_LOGIN override: the default login is then just another App.
  const custom = await decide({ eventName: "pull_request", author: BOT, relayBotLogin: "custom-relay[bot]", files: trap });
  assert.equal(custom.outcome, "pass");
  const customHit = await decide({ eventName: "pull_request", author: "custom-relay[bot]", relayBotLogin: "custom-relay[bot]", files: [{ filename: ".relay/config.yml" }] });
  assert.equal(customHit.outcome, "fail");

  // Pagination follows `Link: rel="next"` and stops when it is absent.
  assert.equal(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"'), "https://api.github.com/x?page=2");
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);

  const requested = [];
  const fakeFetch = async (url, init) => {
    requested.push(url);
    assert.equal(init.headers.Authorization, "Bearer t0k3n");
    const page = requested.length;
    const body = page === 1 ? [{ filename: "a.ts" }, { filename: "b.ts" }] : [{ filename: ".relay/config.yml" }];
    const link = page === 1 ? '<https://api.example/repos/o/r/pulls/7/files?per_page=100&page=2>; rel="next"' : null;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (name) => (name.toLowerCase() === "link" ? link : null) },
      json: async () => body,
    };
  };
  const files = await listPullRequestFiles({ apiUrl: "https://api.example/", repository: "o/r", number: 7, token: "t0k3n", fetchImpl: fakeFetch });
  assert.deepEqual(files.map((f) => f.filename), ["a.ts", "b.ts", ".relay/config.yml"]);
  assert.deepEqual(requested, [
    "https://api.example/repos/o/r/pulls/7/files?per_page=100",
    "https://api.example/repos/o/r/pulls/7/files?per_page=100&page=2",
  ]);

  // A failed page is an error, never an empty (and therefore passing) list.
  const brokenFetch = async () => ({ ok: false, status: 403, statusText: "Forbidden", headers: { get: () => null }, json: async () => ({}) });
  await assert.rejects(
    listPullRequestFiles({ apiUrl: "https://api.example", repository: "o/r", number: 7, token: "t", fetchImpl: brokenFetch }),
    /403 Forbidden/,
  );

  console.log("ok   check-protected-paths self-test: all expectations hold.");
}

if (process.argv.includes("--self-test")) {
  selfTest().catch((error) => {
    console.error(`FAIL check-protected-paths self-test: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(`FAIL check-protected-paths: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
