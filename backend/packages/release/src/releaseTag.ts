/**
 * Eligibility rules for the monorepo's single release tag — see
 * `docs/adr/2026-09-24-monorepo-release-tag-from-guarded-command.md`. The repository has one
 * version, `vMAJOR.MINOR.PATCH`, carried by a git tag on `main`; no package carries its own.
 *
 * Everything that talks to git or GitHub sits behind `ReleaseHost`, so the rules here are the
 * whole decision and are unit-tested without a network.
 */

const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The `.github/workflows/ci.yml` jobs that run on a push to `main` — every one of them must have
 * succeeded for the exact commit being tagged. `review` and `code-review` are required on the
 * promotion pull request but run only on pull requests, so a pushed commit never carries them;
 * they gated the merge that produced this commit instead. Renaming a job in `ci.yml` is a
 * contract change (`docs/operations/required-checks.md`) that must update this list too.
 */
const REQUIRED_CHECKS = [
  "promotion-source",
  "ci",
  "unit",
  "integration",
  "dependency-check",
  "e2e",
  "pi-agent-contract",
] as const;

/** Only a check run created by GitHub Actions counts; any other app could post one named `ci`. */
const CHECK_RUN_APP = "github-actions";

export interface MainBranch {
  sha: string;
  protected: boolean;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  appSlug: string | null;
}

export interface RemoteTag {
  name: string;
  /** The commit the tag points at (peeled, for an annotated tag). */
  sha: string;
}

export interface ReleaseHost {
  readMainBranch(): Promise<MainBranch>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  listRemoteTags(): Promise<RemoteTag[]>;
  /** Creates the annotated tag on `sha` and pushes it; the push never forces, so an existing remote tag is refused. */
  createAndPushTag(tag: string, sha: string): Promise<void>;
}

/** The request is not eligible for a release tag; nothing was created or pushed. */
export class ReleaseRefusedError extends Error {
  override readonly name = "ReleaseRefusedError";
}

function isReleaseTag(tag: string): boolean {
  return RELEASE_TAG_PATTERN.test(tag);
}

/** Fails with the first unmet required check, or passes when every one succeeded on `sha`. */
function assertRequiredChecksSucceeded(sha: string, checkRuns: CheckRun[]): void {
  for (const name of REQUIRED_CHECKS) {
    // A re-run adds a new check run under the same name; only the newest one describes the commit.
    const latest = checkRuns
      .filter((run) => run.name === name && run.appSlug === CHECK_RUN_APP)
      .reduce<CheckRun | undefined>(
        (newest, run) => (newest === undefined || run.id > newest.id ? run : newest),
        undefined,
      );
    if (latest === undefined) {
      throw new ReleaseRefusedError(`Required check "${name}" has not run on ${sha}.`);
    }
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      throw new ReleaseRefusedError(
        `Required check "${name}" on ${sha} is ${latest.status}` +
          (latest.conclusion === null ? "" : ` with conclusion ${latest.conclusion}`) +
          ", not a completed success.",
      );
    }
  }
}

/**
 * Tags `sha` as `tag` only when all of these hold, checked in this order:
 * `tag` is `vMAJOR.MINOR.PATCH`; `sha` is a full commit SHA; `main` is protected and its head is
 * exactly `sha`; neither `tag` nor any other release tag exists on the remote for `sha`; every
 * `REQUIRED_CHECKS` job succeeded on `sha`. `main`'s head is read again right before tagging, so
 * a commit that stopped being `main`'s head while the checks were read is refused rather than
 * tagged.
 */
export async function releaseTag(tag: string, sha: string, host: ReleaseHost): Promise<void> {
  if (!isReleaseTag(tag)) {
    throw new ReleaseRefusedError(`"${tag}" is not a vMAJOR.MINOR.PATCH release tag.`);
  }
  if (!FULL_SHA_PATTERN.test(sha)) {
    throw new ReleaseRefusedError(`"${sha}" is not a full 40-character lowercase commit SHA.`);
  }

  await assertIsProtectedMainHead(sha, host);

  const tags = await host.listRemoteTags();
  const sameName = tags.find((existing) => existing.name === tag);
  if (sameName !== undefined) {
    throw new ReleaseRefusedError(`Tag ${tag} already exists on ${sameName.sha}.`);
  }
  const sameCommit = tags.find((existing) => existing.sha === sha && isReleaseTag(existing.name));
  if (sameCommit !== undefined) {
    throw new ReleaseRefusedError(`${sha} is already released as ${sameCommit.name}.`);
  }

  assertRequiredChecksSucceeded(sha, await host.listCheckRuns(sha));

  await assertIsProtectedMainHead(sha, host);
  await host.createAndPushTag(tag, sha);
}

async function assertIsProtectedMainHead(sha: string, host: ReleaseHost): Promise<void> {
  const main = await host.readMainBranch();
  if (!main.protected) {
    throw new ReleaseRefusedError("main is not a protected branch; refusing to release from it.");
  }
  if (main.sha !== sha) {
    throw new ReleaseRefusedError(`${sha} is not the current head of main (${main.sha}).`);
  }
}
