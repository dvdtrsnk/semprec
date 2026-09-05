import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `packages/shared` is the transport-independent bottom of the backend: the operation catalog,
 * its schemas and the application port live here so that every adapter can depend on them. A
 * dependency on a service would invert that and drag a transport into the catalog, so it is
 * rejected here rather than discovered when an adapter cannot be composed.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const backendRoot = resolve(packageRoot, "../..");
const servicesDir = join(backendRoot, "services");

function listServicePackageNames(): string[] {
  return readdirSync(servicesDir)
    .map((entry) => join(servicesDir, entry, "package.json"))
    .filter((manifest) => {
      try {
        return statSync(manifest).isFile();
      } catch {
        return false;
      }
    })
    .map((manifest) => JSON.parse(readFileSync(manifest, "utf8")).name as string);
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** `import ... from "x"`, `export ... from "x"`, `import("x")` and `require("x")`. */
function listImportSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

const SERVICE_PACKAGE_NAMES = listServicePackageNames();
const SOURCE_FILES = listSourceFiles(join(packageRoot, "src"));

function importsAService(specifier: string, file: string): boolean {
  if (SERVICE_PACKAGE_NAMES.includes(specifier)) return true;
  if (SERVICE_PACKAGE_NAMES.some((name) => specifier.startsWith(`${name}/`))) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = relative(backendRoot, resolve(dirname(file), specifier));
  return resolved === "services" || resolved.startsWith(`services${sep}`);
}

describe("packages/shared dependency rules", () => {
  it("has source files to check", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
  });

  it("imports no service from any source file", () => {
    const violations = SOURCE_FILES.flatMap((file) =>
      listImportSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => importsAService(specifier, file))
        .map((specifier) => `${relative(backendRoot, file)} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it("declares no service package as a dependency", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    expect(declared.filter((name) => SERVICE_PACKAGE_NAMES.includes(name))).toEqual([]);
  });
});
