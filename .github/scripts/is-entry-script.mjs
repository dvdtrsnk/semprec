import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Compare real paths: Node resolves module URLs, but leaves the entry argument's symlinks intact. */
export function isEntryScript(moduleUrl) {
  const entry = process.argv[1];
  // `node -e`, a REPL, or an argument that names no file imports the module without running its CLI.
  if (!entry || !existsSync(entry)) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
