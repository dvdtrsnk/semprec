import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, type ICruiseResult, type IForbiddenRuleType } from "dependency-cruiser";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRulesPath = path.join(packageDir, "..", "..", "..", "dependency-cruiser.rules.json");

export interface BoundaryViolation {
  importer: string;
  imported: string;
  rules: string[];
}

export interface BoundaryCheckResult {
  violations: BoundaryViolation[];
}

function loadForbiddenRules(): IForbiddenRuleType[] {
  const { forbidden } = JSON.parse(readFileSync(repoRulesPath, "utf8")) as {
    forbidden: IForbiddenRuleType[];
  };
  return forbidden;
}

/**
 * Runs the module/service import-boundary rules (see dependency-cruiser.rules.json)
 * against pFileAndDirectoryArray, resolved relative to pBaseDir.
 */
export async function checkModuleBoundaries(
  pBaseDir: string,
  pFileAndDirectoryArray: string[],
): Promise<BoundaryCheckResult> {
  const forbidden = loadForbiddenRules();
  const result = await cruise(
    pFileAndDirectoryArray,
    {
      ruleSet: { forbidden, allowed: [] },
      validate: true,
      baseDir: pBaseDir,
    },
    {},
    undefined,
  );
  const output: ICruiseResult =
    typeof result.output === "string" ? JSON.parse(result.output) : result.output;
  const violations: BoundaryViolation[] = [];
  for (const module of output.modules) {
    for (const dependency of module.dependencies) {
      if (dependency.valid === false) {
        violations.push({
          importer: module.source,
          imported: dependency.resolved,
          rules: (dependency.rules ?? []).map((rule) => rule.name),
        });
      }
    }
  }
  return { violations };
}
