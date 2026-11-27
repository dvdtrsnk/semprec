import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_PAYLOAD_BYTES, parseIdentity, planMirror } from "./mirror-commits.mjs";

const SCRIPT = fileURLToPath(new URL("./mirror-commits.mjs", import.meta.url));

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository whose `base` branch plays the part of what GitHub already has. */
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), "mirror-commits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "base"]);
  git(dir, ["config", "user.name", "Test Author"]);
  git(dir, ["config", "user.email", "author@example.test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "kept.txt"), "kept\n");
  writeFileSync(join(dir, "removed.txt"), "removed\n");
  git(dir, ["add", "."]);
  commit(dir, "Start", "2026-11-27T08:00:00+01:00");
  git(dir, ["checkout", "-q", "-b", "feature"]);
  return dir;
}

function commit(dir, message, date, extraEnv = {}) {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...extraEnv };
  git(dir, ["commit", "-q", "--allow-empty", "-m", message], { env });
  return git(dir, ["rev-parse", "HEAD"]);
}

/**
 * Recreates the plan in a bare repository that has only the `have` refs, the way GitHub's Git
 * Data API would, and returns the SHA each step produced.
 */
function replay(source, plan, have = ["base"]) {
  const remote = mkdtempSync(join(tmpdir(), "mirror-remote-"));
  try {
    git(remote, ["init", "-q", "--bare"]);
    have.forEach((ref, index) => git(source, ["push", "-q", remote, `${ref}:refs/heads/have-${index}`]));
    return plan.steps.map((step) => {
      const payload = JSON.parse(readFileSync(step.input, "utf8"));
      if (step.kind === "blob") {
        const content = Buffer.from(payload.content, "base64");
        return git(remote, ["hash-object", "-w", "--stdin"], { input: content });
      }
      if (step.kind === "tree") {
        const index = join(remote, "replay-index");
        const env = { ...process.env, GIT_INDEX_FILE: index };
        git(remote, ["read-tree", payload.base_tree], { env });
        // Mode 0 and the zero SHA remove a path; --index-info needs no work tree.
        const lines = payload.tree.map((entry) =>
          entry.sha === null ? `0 ${"0".repeat(40)}\t${entry.path}` : `${entry.mode} ${entry.sha}\t${entry.path}`,
        );
        git(remote, ["update-index", "--index-info"], { env, input: `${lines.join("\n")}\n` });
        return git(remote, ["write-tree"], { env });
      }
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: payload.author.name,
        GIT_AUTHOR_EMAIL: payload.author.email,
        GIT_AUTHOR_DATE: payload.author.date,
        GIT_COMMITTER_NAME: payload.committer.name,
        GIT_COMMITTER_EMAIL: payload.committer.email,
        GIT_COMMITTER_DATE: payload.committer.date,
      };
      const parents = payload.parents.flatMap((parent) => ["-p", parent]);
      // commit-tree takes the message from stdin as it is, without git commit's cleanup.
      const result = spawnSync("git", ["commit-tree", payload.tree, ...parents, "-F", "-"], {
        cwd: remote,
        env,
        input: payload.message,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    });
  } finally {
    rmSync(remote, { recursive: true, force: true });
  }
}

test("a replay of the plan reproduces every blob, tree and commit SHA", (t) => {
  const dir = repository(t);
  writeFileSync(join(dir, "kept.txt"), "kept, changed\n");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "binary.bin"), Buffer.from([0, 255, 1, 254, 10]));
  git(dir, ["rm", "-q", "removed.txt"]);
  git(dir, ["add", "."]);
  commit(dir, "Change, add and remove\n\nWith a body.", "2026-11-27T14:55:12+01:30");
  commit(dir, "An empty commit keeps its parent's tree", "2026-11-27T15:00:00-05:00");
  // A merge from the base branch, as finish's §2 makes, with a commit there to merge.
  git(dir, ["checkout", "-q", "base"]);
  writeFileSync(join(dir, "trunk.txt"), "landed on trunk\n");
  git(dir, ["add", "."]);
  commit(dir, "Land something on trunk", "2026-11-27T16:00:00+00:00");
  git(dir, ["checkout", "-q", "feature"]);
  git(dir, ["merge", "-q", "--no-edit", "base"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-27T17:00:00+01:00", GIT_COMMITTER_DATE: "2026-11-27T17:00:00+01:00" },
  });
  // The trunk commit is what GitHub already has, so base..HEAD holds the feature commits and the merge.
  const plan = planMirror({ cwd: dir, have: ["base"], outDir: join(dir, ".mirror") });

  assert.equal(plan.commits, 3);
  assert.equal(plan.head, git(dir, ["rev-parse", "HEAD"]));
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["blob", "blob", "tree", "commit", "commit", "blob", "tree", "commit"],
  );
  assert.equal(plan.steps[0].endpoint, "repos/dvdtrsnk/semprec/git/blobs");
  assert.deepEqual(replay(dir, plan), plan.steps.map((step) => step.expect));
});

test("a deletion is an entry without a SHA, and the message is kept byte for byte", (t) => {
  const dir = repository(t);
  git(dir, ["rm", "-q", "removed.txt"]);
  commit(dir, "Remove a file", "2026-11-27T10:00:00+01:00");
  const plan = planMirror({ cwd: dir, have: ["base"], outDir: join(dir, ".mirror") });

  const tree = JSON.parse(readFileSync(plan.steps[0].input, "utf8"));
  assert.deepEqual(tree.tree, [{ path: "removed.txt", mode: "100644", type: "blob", sha: null }]);
  const commitPayload = JSON.parse(readFileSync(plan.steps[1].input, "utf8"));
  assert.equal(commitPayload.message, "Remove a file\n");
  assert.equal(commitPayload.author.date, "2026-11-27T10:00:00+01:00");
});

test("an identity keeps its own offset, east, west and on a half hour", () => {
  assert.deepEqual(parseIdentity("Jo Doe <jo@example.test> 1795787712 +0130"), {
    name: "Jo Doe",
    email: "jo@example.test",
    date: "2026-11-27T15:25:12+01:30",
  });
  assert.equal(parseIdentity("Jo <jo@example.test> 1795787712 -0500").date, "2026-11-27T08:55:12-05:00");
  assert.throws(() => parseIdentity("Jo jo@example.test 1795787712"), /Unreadable identity/);
});

test("a signed commit is refused, because the API cannot reproduce its signature", (t) => {
  const dir = repository(t);
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  const parent = git(dir, ["rev-parse", "HEAD"]);
  const raw = [
    `tree ${tree}`,
    `parent ${parent}`,
    "author Test Author <author@example.test> 1795787712 +0100",
    "committer Test Author <author@example.test> 1795787712 +0100",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " not a real signature",
    " -----END PGP SIGNATURE-----",
    "",
    "Signed",
    "",
  ].join("\n");
  const signed = git(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: raw });
  git(dir, ["reset", "-q", "--hard", signed]);

  assert.throws(
    () => planMirror({ cwd: dir, have: ["base"], outDir: join(dir, ".mirror") }),
    /carries a gpgsig header/,
  );
});

test("a submodule is refused", (t) => {
  const dir = repository(t);
  const someCommit = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["update-index", "--add", "--cacheinfo", `160000,${someCommit},vendor/sub`]);
  commit(dir, "Add a submodule", "2026-11-27T10:00:00+01:00");

  assert.throws(() => planMirror({ cwd: dir, have: ["base"], outDir: join(dir, ".mirror") }), /changes the submodule vendor\/sub/);
});

test("a file too large for one Access Hub call is refused", (t) => {
  const dir = repository(t);
  writeFileSync(join(dir, "large.bin"), Buffer.alloc(MAX_PAYLOAD_BYTES, 1));
  git(dir, ["add", "."]);
  commit(dir, "Add a large file", "2026-11-27T10:00:00+01:00");

  assert.throws(() => planMirror({ cwd: dir, have: ["base"], outDir: join(dir, ".mirror") }), /exceeds one Access Hub call/);
});

test("the CLI prints the plan, and fails on an empty range and on missing arguments", (t) => {
  const dir = repository(t);
  const empty = spawnSync(process.execPath, [SCRIPT, "--out", join(dir, ".mirror"), "base"], { cwd: dir, encoding: "utf8" });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Nothing to mirror/);

  commit(dir, "One commit", "2026-11-27T10:00:00+01:00");
  const cli = spawnSync(process.execPath, [SCRIPT, "--out", join(dir, ".mirror"), "--repo", "owner/repo", "base"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const plan = JSON.parse(cli.stdout);
  assert.equal(plan.commits, 1);
  assert.deepEqual(plan.steps.map((step) => step.endpoint), ["repos/owner/repo/git/commits"]);

  for (const argv of [[], ["base"], ["--out", join(dir, ".mirror")], ["base", "--out"]]) {
    const usage = spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: dir, encoding: "utf8" });
    assert.equal(usage.status, 2, `argv ${JSON.stringify(argv)}`);
  }
});

test("what the remote branch already has is not planned again, nor what a merge brings from trunk", (t) => {
  const dir = repository(t);
  const pushed = commit(dir, "Already on the remote branch", "2026-11-27T10:00:00+01:00");
  git(dir, ["update-ref", "refs/remotes/origin/feature", pushed]);
  git(dir, ["checkout", "-q", "base"]);
  commit(dir, "Landed on trunk meanwhile", "2026-11-27T11:00:00+01:00");
  git(dir, ["checkout", "-q", "feature"]);
  git(dir, ["merge", "-q", "--no-edit", "base"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-27T12:00:00+01:00", GIT_COMMITTER_DATE: "2026-11-27T12:00:00+01:00" },
  });

  const plan = planMirror({ cwd: dir, have: ["base", "origin/feature"], outDir: join(dir, ".mirror") });

  assert.equal(plan.commits, 1);
  assert.equal(plan.head, git(dir, ["rev-parse", "HEAD"]));
  assert.deepEqual(replay(dir, plan, ["base", "origin/feature"]), plan.steps.map((step) => step.expect));
  assert.throws(() => planMirror({ cwd: dir, have: [], outDir: join(dir, ".mirror") }), /at least one ref/);
});
