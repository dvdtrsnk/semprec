import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("block-model imports", () => {
  it("import only yjs and the module's own files", () => {
    const files = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(sourceDir, file), "utf8");
      const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g)].map(
        (match) => match[1] ?? match[2],
      );
      for (const specifier of specifiers) {
        expect(specifier === "yjs" || specifier?.startsWith("./"), `${file} imports ${specifier}`).toBe(true);
      }
      expect(source, `${file} uses Buffer`).not.toMatch(/\bBuffer\b/);
    }
  });
});
