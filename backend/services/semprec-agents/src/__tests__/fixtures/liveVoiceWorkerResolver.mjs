import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backend = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const entries = new Map([
  ["@semprec/agent-runtime", join(backend, "packages/agent-runtime/dist/index.js")],
  ["@semprec/application", join(backend, "packages/application/dist/index.js")],
]);
export function resolve(specifier, context, nextResolve) {
  const entry = entries.get(specifier);
  if (entry) return { url: pathToFileURL(entry).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
