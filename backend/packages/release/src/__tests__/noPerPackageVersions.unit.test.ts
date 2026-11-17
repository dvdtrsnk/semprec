import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The monorepo's only version is its `vMAJOR.MINOR.PATCH` release tag. A package.json may carry only
 * the `0.0.0` placeholder; a real version would be a second, per-package version that
 * `.github/workflows/release.yml` would tag from outside the guarded release command.
 */
const PLACEHOLDER_VERSION = "0.0.0";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git"]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const packageManifest = z.object({ version: z.string().optional() });

function findPackageManifests(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...findPackageManifests(path.join(directory, entry.name)));
      }
    } else if (entry.name === "package.json") {
      found.push(path.join(directory, entry.name));
    }
  }
  return found;
}

describe("monorepo versioning", () => {
  const manifests = findPackageManifests(repositoryRoot).map((file) => path.relative(repositoryRoot, file));

  it("finds the workspace manifests it guards", () => {
    expect(manifests).toEqual(
      expect.arrayContaining(["backend/package.json", "web/package.json", "backend/packages/release/package.json"]),
    );
  });

  it("gives no package a version of its own", () => {
    const versioned = manifests.filter((file) => {
      const { version } = packageManifest.parse(JSON.parse(readFileSync(path.join(repositoryRoot, file), "utf8")));
      return version !== undefined && version !== PLACEHOLDER_VERSION;
    });

    expect(versioned).toEqual([]);
  });
});
