import { test } from "node:test";
import assert from "node:assert/strict";

import { computeHints, hintsApi } from "./hints.mjs";

const PATH = "backend/src/thing.ts";
const OLD_PATH = "backend/src/oldThing.ts";

/**
 * A fake `api` that serves fixtures and counts every call. `prCommits` is the pull
 * request's commit list, `files` maps a SHA to its file names, `pathCommits` maps a path
 * to the commits touching it on the base branch, `commitPrs` maps a SHA to pull request
 * numbers. `fail` names a function that throws instead.
 */
function fakeApi({ prCommits = [], files = {}, pathCommits = {}, commitPrs = {}, fail } = {}) {
  const calls = [];
  const record = (name, arg, value) => {
    calls.push({ name, arg });
    if (name === fail) return Promise.reject(new Error(`${name} failed`));
    return Promise.resolve(value);
  };
  return {
    calls,
    count: (name, arg) =>
      calls.filter((call) => call.name === name && (arg === undefined || call.arg === arg)).length,
    listPullRequestCommits: (pr) => record("listPullRequestCommits", pr, prCommits),
    getCommitFiles: (sha) => record("getCommitFiles", sha, files[sha] ?? []),
    listCommitsTouchingPath: (options) => record("listCommitsTouchingPath", options, pathCommits[options.path] ?? []),
    listPullRequestsForCommit: (sha) =>
      record("listPullRequestsForCommit", sha, (commitPrs[sha] ?? []).map((number) => ({ number, mergedAt: null }))),
  };
}

async function hintFor(api, finding, { pr = 10 } = {}) {
  const hints = await computeHints(api, {
    pr,
    mergedAt: "2026-09-01T00:00:00Z",
    base: "develop",
    findings: [{ key: "k1", path: PATH, lastSeenSha: "a", ...finding }],
  });
  return hints.get(`${pr}:k1`);
}

test("touchedAfterLastSeen is true when a later commit modifies the path", async () => {
  const api = fakeApi({ prCommits: ["a", "b", "c"], files: { b: ["other.ts"], c: [PATH] } });
  assert.equal((await hintFor(api, {})).touchedAfterLastSeen, true);
});

test("touchedAfterLastSeen is false when no later commit modifies the path", async () => {
  const api = fakeApi({ prCommits: ["a", "b", "c"], files: { a: [PATH], b: ["other.ts"], c: [] } });
  assert.equal((await hintFor(api, {})).touchedAfterLastSeen, false);
  assert.equal(api.count("getCommitFiles", "a"), 0);
});

test("touchedAfterLastSeen is true when a later commit renamed the file away from the path", async () => {
  const api = fakeApi({ prCommits: ["a", "b", "c"], files: { b: [OLD_PATH, PATH] } });
  assert.equal((await hintFor(api, { path: OLD_PATH })).touchedAfterLastSeen, true);
});

test("touchedAfterLastSeen is false when lastSeenSha is the last commit", async () => {
  const api = fakeApi({ prCommits: ["a", "b", "c"], files: { c: [PATH] } });
  assert.equal((await hintFor(api, { lastSeenSha: "c" })).touchedAfterLastSeen, false);
  assert.equal(api.count("getCommitFiles"), 0);
});

test("touchedAfterLastSeen is null when lastSeenSha is empty, without reading the commit list", async () => {
  const api = fakeApi({ prCommits: ["a", "b", "c"], files: { c: [PATH] } });
  assert.equal((await hintFor(api, { lastSeenSha: "" })).touchedAfterLastSeen, null);
  assert.equal(api.count("listPullRequestCommits"), 0);
});

test("touchedAfterLastSeen is null when lastSeenSha is not in the commit list", async () => {
  const api = fakeApi({ prCommits: ["a", "b", "c"], files: { c: [PATH] } });
  assert.equal((await hintFor(api, { lastSeenSha: "rebased" })).touchedAfterLastSeen, null);
});

test("touchedAfterLastSeen is null when the commit list has 250 entries", async () => {
  const prCommits = Array.from({ length: 250 }, (_, i) => `sha${i}`);
  const api = fakeApi({ prCommits, files: { sha249: [PATH] } });
  assert.equal((await hintFor(api, { lastSeenSha: "sha0" })).touchedAfterLastSeen, null);
  assert.equal(api.count("getCommitFiles"), 0);
});

test("laterPrsTouchingPath counts distinct pull requests and excludes the finding's own", async () => {
  const api = fakeApi({
    pathCommits: { [PATH]: ["x", "y", "z"] },
    commitPrs: { x: [20], y: [20, 10], z: [30] },
  });
  assert.equal((await hintFor(api, {}, { pr: 10 })).laterPrsTouchingPath, 2);
});

test("laterPrsTouchingPath is 0 when no commit touches the path since mergedAt", async () => {
  const api = fakeApi({ pathCommits: { [PATH]: [] } });
  assert.equal((await hintFor(api, {})).laterPrsTouchingPath, 0);
  assert.equal(api.count("listPullRequestsForCommit"), 0);
});

test("listCommitsTouchingPath is called with the base branch, the path and mergedAt", async () => {
  const api = fakeApi();
  await hintFor(api, {});
  assert.deepEqual(
    api.calls.filter((call) => call.name === "listCommitsTouchingPath").map((call) => call.arg),
    [{ branch: "develop", path: PATH, since: "2026-09-01T00:00:00Z" }],
  );
});

test("findings sharing a pull request and a path fetch each list once", async () => {
  const api = fakeApi({
    prCommits: ["a", "b", "c"],
    files: { b: ["other.ts"], c: [] },
    pathCommits: { [PATH]: ["x", "y"] },
    commitPrs: { x: [20], y: [30] },
  });
  const hints = await computeHints(api, {
    pr: 10,
    mergedAt: "2026-09-01T00:00:00Z",
    base: "develop",
    findings: [
      { key: "k1", path: PATH, lastSeenSha: "a" },
      { key: "k2", path: PATH, lastSeenSha: "a" },
      { key: "k3", path: PATH, lastSeenSha: "b" },
    ],
  });
  assert.equal(api.count("listPullRequestCommits"), 1);
  assert.equal(api.count("listCommitsTouchingPath"), 1);
  assert.equal(api.count("getCommitFiles", "b"), 1);
  assert.equal(api.count("getCommitFiles", "c"), 1);
  assert.equal(api.count("getCommitFiles"), 2);
  assert.equal(api.count("listPullRequestsForCommit", "x"), 1);
  assert.equal(api.count("listPullRequestsForCommit", "y"), 1);
  assert.equal(api.count("listPullRequestsForCommit"), 2);
  assert.deepEqual(
    [...hints],
    [
      ["10:k1", { touchedAfterLastSeen: false, laterPrsTouchingPath: 2 }],
      ["10:k2", { touchedAfterLastSeen: false, laterPrsTouchingPath: 2 }],
      ["10:k3", { touchedAfterLastSeen: false, laterPrsTouchingPath: 2 }],
    ],
  );
});

for (const fail of ["listPullRequestCommits", "getCommitFiles", "listCommitsTouchingPath", "listPullRequestsForCommit"]) {
  test(`an error from ${fail} rejects computeHints with that error`, async () => {
    const api = fakeApi({
      prCommits: ["a", "b"],
      files: { b: [] },
      pathCommits: { [PATH]: ["x"] },
      commitPrs: { x: [20] },
      fail,
    });
    await assert.rejects(hintFor(api, {}), { message: `${fail} failed` });
  });
}

test("hintsApi binds the GitHub endpoints to the client", async () => {
  const paths = [];
  const client = {
    repository: "owner/repo",
    paginate: async (path, { pick = (page) => page } = {}) => {
      paths.push(path);
      if (path.includes("/pulls/7/commits")) return [{ sha: "a" }];
      if (path.endsWith("/commits/a/pulls?per_page=100")) return [{ number: 8, merged_at: null }];
      if (path.includes("/commits/a?")) return pick({ files: [{ filename: PATH, previous_filename: OLD_PATH }] });
      return [{ sha: "x" }];
    },
  };
  const api = hintsApi(client);
  assert.deepEqual(await api.listPullRequestCommits(7), ["a"]);
  assert.deepEqual(await api.getCommitFiles("a"), [PATH, OLD_PATH]);
  assert.deepEqual(await api.listCommitsTouchingPath({ branch: "develop", path: PATH, since: "2026-09-01" }), ["x"]);
  assert.deepEqual(await api.listPullRequestsForCommit("a"), [{ number: 8, mergedAt: null }]);
  assert.equal(paths.length, 4);
  assert.match(paths[2], /^\/repos\/owner\/repo\/commits\?sha=develop&path=backend%2Fsrc%2Fthing\.ts&since=2026-09-01/);
});
