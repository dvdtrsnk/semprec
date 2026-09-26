/**
 * Computes the two "already fixed?" hints the harvest attaches to every finding it
 * harvests. They only tell the AI verify step where to look first: nothing is ever
 * skipped because of them, and only verify, with evidence, concludes a finding is fixed.
 *
 *   - `touchedAfterLastSeen` — whether the finding's pull request had commits after
 *     `lastSeenSha` (the head the bot last reviewed) that modified the finding's path,
 *     under either name of a rename. It is `null` — unknown, not `false` — when
 *     `lastSeenSha` is `""`, when it is not in the pull request's commit list (a rebase
 *     before merge replaced it), or when that list has 250 entries: GitHub lists at most
 *     250 commits of a pull request, so later commits may be missing.
 *   - `laterPrsTouchingPath` — how many distinct pull requests other than the finding's
 *     own contain a commit that changed the path on `base` since the pull request merged.
 *     The path is matched as given; renames in those later pull requests are not followed.
 *
 * `computeHints` reaches GitHub only through the object `hintsApi` returns, and within
 * one call it fetches each list at most once however many findings share it. Any error
 * from that object rejects the call: a hint is never guessed from a failed read.
 */

import {
  getCommitFiles,
  listCommitsTouchingPath,
  listPullRequestCommits,
  listPullRequestsForCommit,
} from "./github.mjs";

const PR_COMMIT_LIST_CAP = 250;

export function hintsApi(client) {
  return {
    listPullRequestCommits: (pr) => listPullRequestCommits(client, pr),
    getCommitFiles: (sha) => getCommitFiles(client, sha),
    listCommitsTouchingPath: ({ branch, path, since }) => listCommitsTouchingPath(client, { branch, path, since }),
    listPullRequestsForCommit: (sha) => listPullRequestsForCommit(client, sha),
  };
}

/** `load(key)` called at most once per key; the stored promise is shared by every caller. */
function memoize(load) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, load(key));
    return cache.get(key);
  };
}

/**
 * Hints for `findings` (`{ key, path, lastSeenSha }`) of pull request `pr`, merged into
 * `base` at `mergedAt`, as a Map from `"<pr>:<key>"` to
 * `{ touchedAfterLastSeen, laterPrsTouchingPath }`. A finding whose `key`, `path` or
 * `lastSeenSha` is not a string rejects the call before any GitHub read.
 */
export async function computeHints(api, { pr, mergedAt, base, findings }) {
  let prCommits = null;
  const prCommitList = () => (prCommits ??= api.listPullRequestCommits(pr));
  const commitFiles = memoize((sha) => api.getCommitFiles(sha));
  const pathCommits = memoize((path) => api.listCommitsTouchingPath({ branch: base, path, since: mergedAt }));
  const commitPrs = memoize((sha) => api.listPullRequestsForCommit(sha));

  async function touchedAfterLastSeen({ path, lastSeenSha }) {
    if (lastSeenSha === "") return null;
    const commits = await prCommitList();
    if (commits.length >= PR_COMMIT_LIST_CAP) return null;
    const index = commits.indexOf(lastSeenSha);
    if (index === -1) return null;
    for (const sha of commits.slice(index + 1)) {
      if ((await commitFiles(sha)).includes(path)) return true;
    }
    return false;
  }

  async function laterPrsTouchingPath(path) {
    const numbers = new Set();
    for (const sha of await pathCommits(path)) {
      for (const { number } of await commitPrs(sha)) {
        if (number !== pr) numbers.add(number);
      }
    }
    return numbers.size;
  }

  for (const finding of findings) {
    for (const field of ["key", "path", "lastSeenSha"]) {
      if (typeof finding?.[field] !== "string") {
        throw new TypeError(`computeHints: finding ${JSON.stringify(finding?.key)} has a non-string ${field}`);
      }
    }
  }

  const hints = new Map();
  for (const finding of findings) {
    hints.set(`${pr}:${finding.key}`, {
      touchedAfterLastSeen: await touchedAfterLastSeen(finding),
      laterPrsTouchingPath: await laterPrsTouchingPath(finding.path),
    });
  }
  return hints;
}
