import { resolve } from "node:path";
import { diagnoseCatalog, digest, readBounded, relayIndex, serializeRecord } from "./records.mjs";

/** Preserve explicitly recorded import debt only while the original issue bytes are unchanged. */
export async function validateCatalog(root, catalog) {
  relayIndex(catalog);
  const diagnostics = diagnoseCatalog(catalog);
  let manifest;
  try { manifest = JSON.parse(await readBounded(resolve(root, "issues/migration/manifest.json"), 20_000_000)); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const historical = []; const errors = [];
  const known = new Set((manifest?.diagnostics ?? []).map(value => JSON.stringify(value)));
  const files = new Map((manifest?.files ?? []).map(file => [file.path, file.sha256]));
  for (const diagnostic of diagnostics) {
    const issue = catalog.get(diagnostic.id);
    const original = files.get(`issues/items/${diagnostic.id}.md`);
    if (known.has(JSON.stringify(diagnostic)) && issue && digest(serializeRecord(issue)) === original) historical.push(diagnostic);
    else errors.push(diagnostic);
  }
  return { count: catalog.size, errors, historical };
}
