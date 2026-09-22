import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #243's acceptance criterion: "No service outside packages/data is configured with the
 * `semprec_data` connection string." `semprec-api` and `semprec-transcribe` are the two
 * narrow choke-point hosts; every other service's `.env.example` must document
 * `semprec_side` and must never mention `semprec_data`. See docs/operations/database-roles.md.
 */
const SERVICES_DIR = path.join(fileURLToPath(import.meta.url), "../../../../../services");
const CHOKE_POINT_HOSTING_SERVICES = new Set(["semprec-api", "semprec-transcribe"]);

async function listServiceEnvExamples(): Promise<Array<{ service: string; contents: string }>> {
  const entries = await readdir(SERVICES_DIR, { withFileTypes: true });
  const services = entries.filter((e) => e.isDirectory());
  const files = await Promise.all(
    services.map(async (entry) => {
      const filePath = path.join(SERVICES_DIR, entry.name, ".env.example");
      try {
        return { service: entry.name, contents: await readFile(filePath, "utf8") };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      }
    }),
  );
  return files.filter((f): f is { service: string; contents: string } => f !== null);
}

describe("service .env.example database role configuration", () => {
  it("only choke-point-hosting services document the semprec_data connection string", async () => {
    const envExamples = await listServiceEnvExamples();
    expect(envExamples.length).toBeGreaterThan(0);
    for (const service of CHOKE_POINT_HOSTING_SERVICES) {
      expect(envExamples.some((e) => e.service === service)).toBe(true);
    }

    for (const { service, contents } of envExamples) {
      if (CHOKE_POINT_HOSTING_SERVICES.has(service)) {
        expect(contents).toContain("semprec_data");
      } else {
        expect(contents).not.toContain("semprec_data");
        expect(contents).toContain("semprec_side");
      }
    }
  });
});
