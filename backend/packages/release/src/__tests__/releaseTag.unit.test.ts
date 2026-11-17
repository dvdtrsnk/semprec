import { describe, expect, it } from "vitest";
import { ReleaseRefusedError, releaseTag, type CheckRun, type ReleaseHost, type RemoteTag } from "../releaseTag.js";

const MAIN_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const REQUIRED = ["promotion-source", "ci", "unit", "integration", "dependency-check", "e2e", "pi-agent-contract"];

function greenRuns(): CheckRun[] {
  return REQUIRED.map((name, index) => ({
    id: index + 1,
    name,
    status: "completed",
    conclusion: "success",
    appSlug: "github-actions",
  }));
}

interface FakeHostOptions {
  mainShas?: string[];
  protected?: boolean;
  checkRuns?: CheckRun[];
  tags?: RemoteTag[];
}

function fakeHost(options: FakeHostOptions = {}) {
  const mainShas = [...(options.mainShas ?? [MAIN_SHA])];
  const pushed: { tag: string; sha: string }[] = [];
  const checkRunsReadFor: string[] = [];
  const host: ReleaseHost = {
    async readMainBranch() {
      // Each read returns the next head; the last one repeats, so a single entry is a stable main.
      const sha = mainShas.length > 1 ? mainShas.shift()! : mainShas[0]!;
      return { sha, protected: options.protected ?? true };
    },
    async listCheckRuns(sha) {
      checkRunsReadFor.push(sha);
      return options.checkRuns ?? greenRuns();
    },
    async listRemoteTags() {
      return options.tags ?? [];
    },
    async createAndPushTag(tag, sha) {
      pushed.push({ tag, sha });
    },
  };
  return { host, pushed, checkRunsReadFor };
}

async function expectRefused(promise: Promise<void>, message: RegExp): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ReleaseRefusedError);
  expect((error as Error).message).toMatch(message);
}

describe("releaseTag", () => {
  it("tags the green head of protected main, binding the tag to that exact SHA", async () => {
    const { host, pushed, checkRunsReadFor } = fakeHost();

    await releaseTag("v1.2.3", MAIN_SHA, host);

    expect(pushed).toEqual([{ tag: "v1.2.3", sha: MAIN_SHA }]);
    expect(checkRunsReadFor).toEqual([MAIN_SHA]);
  });

  it("accepts a zero major and minor", async () => {
    const { host, pushed } = fakeHost();

    await releaseTag("v0.0.1", MAIN_SHA, host);

    expect(pushed).toEqual([{ tag: "v0.0.1", sha: MAIN_SHA }]);
  });

  it.each([
    "1.2.3",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2.3-rc.1",
    "v1.2.3+build",
    " v1.2.3",
    "V1.2.3",
  ])("refuses the malformed tag %j", async (tag) => {
    const { host, pushed } = fakeHost();

    await expectRefused(releaseTag(tag, MAIN_SHA, host), /is not a vMAJOR\.MINOR\.PATCH release tag/);
    expect(pushed).toEqual([]);
  });

  it.each(["aaaaaaa", "A".repeat(40), "main", `${MAIN_SHA}0`])("refuses the non-SHA target %j", async (sha) => {
    const { host, pushed } = fakeHost();

    await expectRefused(releaseTag("v1.0.0", sha, host), /is not a full 40-character lowercase commit SHA/);
    expect(pushed).toEqual([]);
  });

  it("refuses a commit that is not the head of main", async () => {
    const { host, pushed, checkRunsReadFor } = fakeHost({ mainShas: [OTHER_SHA] });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), /is not the current head of main/);
    expect(pushed).toEqual([]);
    expect(checkRunsReadFor).toEqual([]);
  });

  it("refuses when main is not protected", async () => {
    const { host, pushed } = fakeHost({ protected: false });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), /main is not a protected branch/);
    expect(pushed).toEqual([]);
  });

  it("refuses when main moved on while the checks were being read", async () => {
    const { host, pushed } = fakeHost({ mainShas: [MAIN_SHA, OTHER_SHA] });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), /is not the current head of main \(b{40}\)/);
    expect(pushed).toEqual([]);
  });

  it("refuses a tag name that already exists", async () => {
    const { host, pushed } = fakeHost({ tags: [{ name: "v1.0.0", sha: OTHER_SHA }] });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), /Tag v1\.0\.0 already exists on b{40}/);
    expect(pushed).toEqual([]);
  });

  it("refuses a second release tag on an already released commit", async () => {
    const { host, pushed } = fakeHost({ tags: [{ name: "v1.0.0", sha: MAIN_SHA }] });

    await expectRefused(releaseTag("v1.0.1", MAIN_SHA, host), /is already released as v1\.0\.0/);
    expect(pushed).toEqual([]);
  });

  it("ignores a non-release tag on the same commit", async () => {
    const { host, pushed } = fakeHost({ tags: [{ name: "deploy-marker", sha: MAIN_SHA }] });

    await releaseTag("v1.0.0", MAIN_SHA, host);

    expect(pushed).toEqual([{ tag: "v1.0.0", sha: MAIN_SHA }]);
  });

  it.each(REQUIRED)("refuses when the required check %s has not run on the commit", async (name) => {
    const { host, pushed } = fakeHost({ checkRuns: greenRuns().filter((run) => run.name !== name) });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), new RegExp(`Required check "${name}" has not run`));
    expect(pushed).toEqual([]);
  });

  it("refuses a failed required check", async () => {
    const checkRuns = greenRuns().map((run) => (run.name === "e2e" ? { ...run, conclusion: "failure" } : run));
    const { host, pushed } = fakeHost({ checkRuns });

    await expectRefused(
      releaseTag("v1.0.0", MAIN_SHA, host),
      /Required check "e2e" on a{40} is completed with conclusion failure, not a completed success/,
    );
    expect(pushed).toEqual([]);
  });

  it("refuses a required check that is still running", async () => {
    const checkRuns = greenRuns().map((run) =>
      run.name === "integration" ? { ...run, status: "in_progress", conclusion: null } : run,
    );
    const { host, pushed } = fakeHost({ checkRuns });

    await expectRefused(
      releaseTag("v1.0.0", MAIN_SHA, host),
      /Required check "integration" on a{40} is in_progress, not a completed success/,
    );
    expect(pushed).toEqual([]);
  });

  it("refuses when the newest run of a required check failed, even though an older one succeeded", async () => {
    const checkRuns = [
      ...greenRuns(),
      { id: 100, name: "unit", status: "completed", conclusion: "failure", appSlug: "github-actions" },
    ];
    const { host, pushed } = fakeHost({ checkRuns });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), /Required check "unit" .* conclusion failure/);
    expect(pushed).toEqual([]);
  });

  it("accepts when the newest run of a required check succeeded after an older failure", async () => {
    const checkRuns = [
      { id: 0, name: "unit", status: "completed", conclusion: "failure", appSlug: "github-actions" },
      ...greenRuns(),
    ];
    const { host, pushed } = fakeHost({ checkRuns });

    await releaseTag("v1.0.0", MAIN_SHA, host);

    expect(pushed).toEqual([{ tag: "v1.0.0", sha: MAIN_SHA }]);
  });

  it("does not count a same-named check run posted by an app other than GitHub Actions", async () => {
    const checkRuns = greenRuns().map((run) => (run.name === "ci" ? { ...run, appSlug: "some-other-app" } : run));
    const { host, pushed } = fakeHost({ checkRuns });

    await expectRefused(releaseTag("v1.0.0", MAIN_SHA, host), /Required check "ci" has not run/);
    expect(pushed).toEqual([]);
  });

  it("propagates a host failure unchanged rather than reporting it as a refusal", async () => {
    const { host } = fakeHost();
    const failure = new Error("gh: network unreachable");
    host.listRemoteTags = async () => {
      throw failure;
    };

    await expect(releaseTag("v1.0.0", MAIN_SHA, host)).rejects.toBe(failure);
  });
});
