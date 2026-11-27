#!/usr/bin/env node
/**
 * Plans how to recreate on GitHub, through its Git Data API, the commits of HEAD that GitHub does
 * not have yet, with the same blob, tree and commit SHAs they have locally.
 *
 * Usage: `node mirror-commits.mjs --out <dir> [--repo owner/repo] <have>...`, run inside the
 * branch's worktree after `git fetch origin`. Each `<have>` is a ref GitHub already has: always
 * `origin/develop`, and `origin/<branch>` once the branch exists there. The commits planned are
 * `git rev-list HEAD --not <have>...`, so a merge from `develop` plans only the merge commit, not
 * the `develop` commits it brings in. The repo defaults to `dvdtrsnk/semprec`.
 *
 * ## Why
 *
 * On the Mac mini neither `git push` nor `gh` has GitHub credentials. GitHub is reached only
 * through the project's Access Hub authorization, which runs `gh` without a git transport. The
 * `finish` skill therefore recreates each commit with `POST git/blobs`, `POST git/trees` and
 * `POST git/commits` and moves the branch with `git/refs`. GitHub hashes what it is given the way
 * git does, so a commit recreated from its exact tree entries, parents, message, author and
 * committer (dates with their original offset) gets the local SHA again. Issue completion records
 * and review threads that cite those SHAs keep pointing at the right commits.
 *
 * ## Output
 *
 * One JSON payload file per API call, numbered in the order the calls must be made, and on stdout
 * a plan: `{ head, commits, steps: [{ kind, endpoint, input, expect }] }`. Every call is
 * `gh api <endpoint> --method POST --input <input> --jq .sha`, and the SHA it prints must equal
 * `expect`. A difference means GitHub did not reproduce the commit, and the caller stops.
 *
 * ## What it refuses
 *
 * It throws instead of planning a commit the API cannot reproduce or a call Access Hub cannot
 * carry:
 * - a header other than tree, parent, author and committer (a `gpgsig` signature, a `mergetag`, an
 *   `encoding`), because the API does not accept it;
 * - a submodule entry;
 * - a root commit, because every commit is built on a parent GitHub has;
 * - a payload over `MAX_PAYLOAD_BYTES`, the input limit of one Access Hub call.
 * An empty range is an error too: there is nothing to push.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isEntryScript } from "./is-entry-script.mjs";

/** The input limit of one Access Hub call is 1 MiB; this leaves room for the call's own framing. */
export const MAX_PAYLOAD_BYTES = 1_000_000;

const KNOWN_HEADERS = new Set(["tree", "parent", "author", "committer"]);

function git(cwd, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd, encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return result.stdout;
}

/** `Name <email> 1764251700 +0130` as the API's identity: the date in ISO 8601 with its own offset. */
export function parseIdentity(line) {
  const match = /^(.*) <(.*)> (\d+) ([+-])(\d{2})(\d{2})$/.exec(line);
  if (!match) throw new Error(`Unreadable identity: ${line}`);
  const [, name, email, seconds, sign, hours, minutes] = match;
  const offsetMinutes = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  const local = new Date((Number(seconds) + offsetMinutes * 60) * 1000).toISOString().slice(0, 19);
  return { name, email, date: `${local}${sign}${hours}:${minutes}` };
}

/** The headers and the exact message of a raw commit object. */
export function parseCommit(sha, raw) {
  const split = raw.indexOf("\n\n");
  const headerText = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? "" : raw.slice(split + 2);
  const headers = { parents: [] };
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of a multi-line header, refused below
    const space = line.indexOf(" ");
    const field = line.slice(0, space);
    const value = line.slice(space + 1);
    if (!KNOWN_HEADERS.has(field)) {
      throw new Error(`${sha} carries a ${field} header, which the Git Data API cannot reproduce`);
    }
    if (field === "parent") headers.parents.push(value);
    else headers[field] = value;
  }
  return { tree: headers.tree, parents: headers.parents, author: headers.author, committer: headers.committer, message };
}

/** The entries of `git diff-tree -r -z --raw` between two commits. */
function changedEntries(cwd, from, to) {
  const fields = git(cwd, ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-commit-id", from, to]).split("\0");
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, , newSha, status] = fields[i].slice(1).split(" ");
    entries.push({ oldMode, newMode, newSha, status, path: fields[i + 1] });
  }
  return entries;
}

function payloadText(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    throw new Error(`A payload of ${Buffer.byteLength(text)} bytes exceeds one Access Hub call`);
  }
  return text;
}

/** Writes the payloads of the commits of HEAD that `have` lacks into `outDir` and returns the plan. */
export function planMirror({ cwd, have, outDir, repo = "dvdtrsnk/semprec" }) {
  if (have.length === 0) throw new Error("Name at least one ref GitHub already has");
  const commits = git(cwd, ["rev-list", "--reverse", "--topo-order", "HEAD", "--not", ...have])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0) throw new Error(`Nothing to mirror: HEAD has no commit that ${have.join(", ")} lack`);
  mkdirSync(outDir, { recursive: true });
  const steps = [];
  const blobs = new Set();
  const write = (kind, sha, value) => {
    const input = path.resolve(outDir, `${String(steps.length + 1).padStart(4, "0")}-${kind}-${sha}.json`);
    writeFileSync(input, payloadText(value));
    steps.push({ kind, endpoint: `repos/${repo}/git/${kind}s`, input, expect: sha });
  };
  for (const sha of commits) {
    const commit = parseCommit(sha, git(cwd, ["cat-file", "commit", sha]));
    if (commit.parents.length === 0) throw new Error(`${sha} is a root commit; mirroring needs a parent GitHub has`);
    const firstParentTree = git(cwd, ["rev-parse", `${commit.parents[0]}^{tree}`]).trim();
    if (commit.tree !== firstParentTree) {
      const tree = [];
      for (const entry of changedEntries(cwd, commit.parents[0], sha)) {
        if (entry.status === "D") {
          tree.push({ path: entry.path, mode: entry.oldMode, type: "blob", sha: null });
          continue;
        }
        if (entry.newMode === "160000") throw new Error(`${sha} changes the submodule ${entry.path}`);
        if (!blobs.has(entry.newSha)) {
          blobs.add(entry.newSha);
          const content = git(cwd, ["cat-file", "blob", entry.newSha], "buffer").toString("base64");
          write("blob", entry.newSha, { content, encoding: "base64" });
        }
        tree.push({ path: entry.path, mode: entry.newMode, type: "blob", sha: entry.newSha });
      }
      write("tree", commit.tree, { base_tree: firstParentTree, tree });
    }
    write("commit", sha, {
      message: commit.message,
      tree: commit.tree,
      parents: commit.parents,
      author: parseIdentity(commit.author),
      committer: parseIdentity(commit.committer),
    });
  }
  return { head: commits.at(-1), commits: commits.length, steps };
}

/** `--out <dir> [--repo owner/repo] <have>...` as options, or null when it is not that. */
export function parseArguments(argv) {
  const options = { have: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" || argv[i] === "--repo") {
      if (i + 1 >= argv.length) return null;
      options[argv[i].slice(2) === "out" ? "outDir" : "repo"] = argv[i + 1];
      i += 1;
    } else {
      options.have.push(argv[i]);
    }
  }
  return options.outDir && options.have.length > 0 ? options : null;
}

if (isEntryScript(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error("Usage: node mirror-commits.mjs --out <dir> [--repo owner/repo] <have>...");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(planMirror({ cwd: process.cwd(), ...options }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
