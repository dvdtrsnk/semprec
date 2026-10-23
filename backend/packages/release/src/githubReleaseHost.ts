import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { CheckRun, MainBranch, ReleaseHost, RemoteTag } from "./releaseTag.js";

const execFileAsync = promisify(execFile);

// A stalled network call must not hang the release command (io-hardening: always a timeout and
// a cap on what is read back).
const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** GitHub's own ceiling for one page of check runs; more than this on one commit is refused, not paged. */
const CHECK_RUNS_PER_PAGE = 100;

const REMOTE = "origin";

const branchResponse = z.object({
  commit: z.object({ sha: z.string() }),
  protected: z.boolean(),
});

const checkRunsResponse = z.object({
  total_count: z.number().int(),
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      app: z.object({ slug: z.string() }).nullable(),
    }),
  ),
});

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
    encoding: "utf8",
  });
  return stdout;
}

async function githubApi(path: string): Promise<unknown> {
  return JSON.parse(await run("gh", ["api", path])) as unknown;
}

/**
 * `owner/name` of the GitHub repository behind `origin`, so the GitHub API reads and the git
 * push address the same repository.
 */
export function parseGithubRepository(remoteUrl: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remoteUrl.trim(),
    );
  if (match?.[1] === undefined) {
    throw new Error(`Remote "${REMOTE}" (${remoteUrl.trim()}) is not a github.com repository URL.`);
  }
  return match[1];
}

/**
 * Parses `git ls-remote --tags` output. An annotated tag is listed twice — the tag object, then
 * `<name>^{}` with the commit it points at — and the commit is what a release tag is bound to.
 */
export function parseRemoteTags(lsRemoteOutput: string): RemoteTag[] {
  const byName = new Map<string, string>();
  for (const line of lsRemoteOutput.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`Unexpected git ls-remote line: ${line}`);
    }
    const [, sha, name, peeled] = match;
    if (peeled !== undefined || !byName.has(name)) {
      byName.set(name, sha);
    }
  }
  return [...byName].map(([name, sha]) => ({ name, sha }));
}

export async function createGithubReleaseHost(): Promise<ReleaseHost> {
  const repository = parseGithubRepository(await run("git", ["remote", "get-url", REMOTE]));

  return {
    async readMainBranch(): Promise<MainBranch> {
      const branch = branchResponse.parse(await githubApi(`repos/${repository}/branches/main`));
      return { sha: branch.commit.sha, protected: branch.protected };
    },

    async listCheckRuns(sha: string): Promise<CheckRun[]> {
      const response = checkRunsResponse.parse(
        await githubApi(`repos/${repository}/commits/${sha}/check-runs?filter=all&per_page=${CHECK_RUNS_PER_PAGE}`),
      );
      // Fail closed: a check run on a page not read could be the newer, failed run of a required job.
      if (response.total_count > response.check_runs.length) {
        throw new Error(
          `${sha} has ${response.total_count} check runs, more than the ${CHECK_RUNS_PER_PAGE} read in one page.`,
        );
      }
      return response.check_runs.map((checkRun) => ({
        id: checkRun.id,
        name: checkRun.name,
        status: checkRun.status,
        conclusion: checkRun.conclusion,
        appSlug: checkRun.app?.slug ?? null,
      }));
    },

    async listRemoteTags(): Promise<RemoteTag[]> {
      return parseRemoteTags(await run("git", ["ls-remote", "--tags", REMOTE]));
    },

    async createAndPushTag(tag: string, sha: string): Promise<void> {
      await run("git", ["fetch", "--no-tags", REMOTE, sha]);
      await run("git", ["tag", "--annotate", "--message", `Release ${tag}`, tag, sha]);
      try {
        await run("git", ["push", REMOTE, `refs/tags/${tag}`]);
      } catch (err) {
        // Leaving the local tag would make a retry fail at `git tag` for a release that never
        // reached the remote. A failed removal must not replace the push error, which is the real one.
        try {
          await run("git", ["tag", "--delete", tag]);
        } catch (cleanupErr) {
          console.error(`Could not remove the local tag ${tag} after the failed push; delete it by hand.`, cleanupErr);
        }
        throw err;
      }
    },
  };
}
