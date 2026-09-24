import { createGithubReleaseHost } from "./githubReleaseHost.js";
import { ReleaseRefusedError, releaseTag } from "./releaseTag.js";

/**
 * `pnpm --filter @semprec/release run release-tag <vMAJOR.MINOR.PATCH> <main-commit-sha>` —
 * see `docs/operations/releases.md`. Exit code 2 is a refusal (nothing was tagged), 1 an
 * operational failure (git, `gh`, or the network).
 */
const [tag, sha, ...rest] = process.argv.slice(2);
if (tag === undefined || sha === undefined || rest.length > 0) {
  console.error("Usage: release-tag <vMAJOR.MINOR.PATCH> <main-commit-sha>");
  process.exit(2);
}

try {
  await releaseTag(tag, sha, await createGithubReleaseHost());
  console.log(`Tagged ${sha} as ${tag} and pushed it.`);
} catch (err) {
  if (err instanceof ReleaseRefusedError) {
    console.error(`Refused: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
