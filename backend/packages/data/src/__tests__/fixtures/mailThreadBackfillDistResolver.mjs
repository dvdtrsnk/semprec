import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backend = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const blockRoot = realpathSync(join(backend, "../shared/block-model/node_modules"));
const blockEntry = process.env.BATCH17_BLOCK_MODEL_ENTRY;
if (!blockEntry || !isAbsolute(blockEntry)) throw new Error("Missing temporary block-model entry");
const block = realpathSync(blockEntry);
if (!block.startsWith(`${blockRoot}${sep}.batch17-`) || !block.endsWith(`${sep}index.js`)) {
  throw new Error("Invalid temporary block-model entry");
}
const entries = new Map([
  ["@semprec/block-model", block],
  ["@semprec/shared", join(backend, "packages/shared/dist/index.js")],
  ["@semprec/queue", join(backend, "packages/queue/dist/index.js")],
  ["@semprec/module-registry", join(backend, "packages/module-registry/dist/index.js")],
  ["@semprec/credentials", join(backend, "packages/credentials/dist/index.js")],
  ["@semprec/ai-gateway-client", join(backend, "packages/ai-gateway-client/dist/index.js")],
]);

export function resolve(specifier, context, nextResolve) {
  const entry = entries.get(specifier);
  if (entry) return { url: pathToFileURL(realpathSync(entry)).href, shortCircuit: true };
  if (specifier.startsWith("@semprec/")) throw new Error(`Unlisted workspace export: ${specifier}`);
  return nextResolve(specifier, context);
}
