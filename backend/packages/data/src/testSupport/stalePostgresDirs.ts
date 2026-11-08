import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const STALE_POSTGRES_DIR_PREFIX = "semprec-pg-";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface SweepStalePostgresDirsOptions {
  tmpDir: string;
  now?: () => number;
  maxAgeMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

async function hasLiveOwner(dir: string, isPidAlive: (pid: number) => boolean): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path.join(dir, "postmaster.pid"), "utf8");
  } catch {
    return false;
  }
  const pid = Number(contents.split("\n", 1)[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return isPidAlive(pid);
}

/**
 * Removes `semprec-pg-*` directories left behind by an embedded-Postgres test run that never
 * reached its vitest globalSetup teardown (killed run, crashed process). A directory is only
 * swept once it is both old enough and has no live postmaster claiming it.
 */
export async function sweepStalePostgresDirs(options: SweepStalePostgresDirsOptions): Promise<string[]> {
  const { tmpDir, now = Date.now, maxAgeMs = DEFAULT_MAX_AGE_MS, isPidAlive = defaultIsPidAlive } = options;

  const entries = await readdir(tmpDir, { withFileTypes: true });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STALE_POSTGRES_DIR_PREFIX)) continue;
    const dir = path.join(tmpDir, entry.name);
    let stats;
    try {
      stats = await stat(dir);
    } catch (err) {
      // ENOENT: another process may already have removed this directory; nothing to sweep.
      // Anything else (EACCES, EIO, ...) is a real failure and must surface.
      if (err instanceof Error && "code" in err && err.code === "ENOENT") continue;
      throw err;
    }
    if (now() - stats.mtimeMs < maxAgeMs) continue;
    if (await hasLiveOwner(dir, isPidAlive)) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Another process may already be removing this directory; keep sweeping the rest.
    }
  }
  return removed;
}
