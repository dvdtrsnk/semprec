import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStalePostgresDirs } from "../stalePostgresDirs.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

describe("sweepStalePostgresDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "stale-pg-dirs-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeDir(name: string, ageMs: number): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir);
    await setAge(dir, ageMs);
    return dir;
  }

  async function setAge(dir: string, ageMs: number): Promise<void> {
    const mtime = new Date(NOW - ageMs);
    await utimes(dir, mtime, mtime);
  }

  it("removes a 25h-old directory with no postmaster.pid", async () => {
    const dir = await makeDir("semprec-pg-nopid", 25 * HOUR_MS);

    const removed = await sweepStalePostgresDirs({ tmpDir: root, now: () => NOW });

    expect(removed).toEqual([dir]);
  });

  it("removes a 25h-old directory whose postmaster.pid names a dead pid", async () => {
    const dir = await makeDir("semprec-pg-deadpid", 25 * HOUR_MS);
    await writeFile(path.join(dir, "postmaster.pid"), "4242\n/some/data/dir\n");
    await setAge(dir, 25 * HOUR_MS);

    const removed = await sweepStalePostgresDirs({
      tmpDir: root,
      now: () => NOW,
      isPidAlive: (pid) => {
        expect(pid).toBe(4242);
        return false;
      },
    });

    expect(removed).toEqual([dir]);
  });

  it("keeps a 25h-old directory whose pid is alive", async () => {
    const dir = await makeDir("semprec-pg-alivepid", 25 * HOUR_MS);
    await writeFile(path.join(dir, "postmaster.pid"), "4242\n/some/data/dir\n");
    await setAge(dir, 25 * HOUR_MS);

    const removed = await sweepStalePostgresDirs({
      tmpDir: root,
      now: () => NOW,
      isPidAlive: () => true,
    });

    expect(removed).toEqual([]);
    await expect(stat(dir)).resolves.toBeDefined();
  });

  it("keeps a 1h-old directory with no pid file", async () => {
    await makeDir("semprec-pg-fresh", 1 * HOUR_MS);

    const removed = await sweepStalePostgresDirs({ tmpDir: root, now: () => NOW });

    expect(removed).toEqual([]);
  });

  it("ignores a sibling entry not named semprec-pg-*", async () => {
    await makeDir("some-other-dir", 25 * HOUR_MS);

    const removed = await sweepStalePostgresDirs({ tmpDir: root, now: () => NOW });

    expect(removed).toEqual([]);
  });

  it("returns exactly the removed paths", async () => {
    const stale = await makeDir("semprec-pg-stale", 25 * HOUR_MS);
    await makeDir("semprec-pg-fresh2", 1 * HOUR_MS);
    await makeDir("unrelated", 25 * HOUR_MS);

    const removed = await sweepStalePostgresDirs({ tmpDir: root, now: () => NOW });

    expect(removed).toEqual([stale]);
  });
});
