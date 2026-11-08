import { describe, expect, it } from "vitest";
import { parseGithubRepository, parseRemoteTags } from "../githubReleaseHost.js";

const TAG_OBJECT_SHA = "1".repeat(40);
const COMMIT_SHA = "2".repeat(40);
const LIGHTWEIGHT_SHA = "3".repeat(40);

describe("parseRemoteTags", () => {
  it("binds an annotated tag to the peeled commit, not the tag object", () => {
    const output = `${TAG_OBJECT_SHA}\trefs/tags/v1.0.0\n${COMMIT_SHA}\trefs/tags/v1.0.0^{}\n`;

    expect(parseRemoteTags(output)).toEqual([{ name: "v1.0.0", sha: COMMIT_SHA }]);
  });

  it("binds a lightweight tag to the commit it names", () => {
    expect(parseRemoteTags(`${LIGHTWEIGHT_SHA}\trefs/tags/v0.1.0\n`)).toEqual([
      { name: "v0.1.0", sha: LIGHTWEIGHT_SHA },
    ]);
  });

  it("returns every tag and nothing for empty output", () => {
    const output = `${TAG_OBJECT_SHA}\trefs/tags/v1.0.0\n${COMMIT_SHA}\trefs/tags/v1.0.0^{}\n${LIGHTWEIGHT_SHA}\trefs/tags/other\n`;

    expect(parseRemoteTags(output)).toEqual([
      { name: "v1.0.0", sha: COMMIT_SHA },
      { name: "other", sha: LIGHTWEIGHT_SHA },
    ]);
    expect(parseRemoteTags("")).toEqual([]);
  });

  it("rejects a line it cannot parse instead of skipping it", () => {
    expect(() => parseRemoteTags("not a ref line\n")).toThrow(/Unexpected git ls-remote line/);
  });
});

describe("parseGithubRepository", () => {
  it.each([
    ["https://github.com/dvdtrsnk/semprec.git\n", "dvdtrsnk/semprec"],
    ["https://github.com/dvdtrsnk/semprec", "dvdtrsnk/semprec"],
    ["git@github.com:dvdtrsnk/semprec.git", "dvdtrsnk/semprec"],
    ["ssh://git@github.com/dvdtrsnk/semprec.git", "dvdtrsnk/semprec"],
  ])("reads %j as %s", (url, repository) => {
    expect(parseGithubRepository(url)).toBe(repository);
  });

  it.each(["https://gitlab.example.com/dvdtrsnk/semprec.git", "https://github.com/dvdtrsnk", "/local/path/semprec"])(
    "rejects the non-GitHub remote %j",
    (url) => {
      expect(() => parseGithubRepository(url)).toThrow(/is not a github\.com repository URL/);
    },
  );
});
