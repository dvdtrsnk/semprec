const { forbidden } = require("./dependency-cruiser.rules.json");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden,
  options: {
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "types"],
    },
    // `doNotFollow` (not `exclude`) so a rule can still match the direct edge into a
    // node_modules package (e.g. "nothing outside the gateway/agent-runtime may import a
    // provider SDK directly") without depcruise recursing into that package's own dependency
    // tree, which is what makes this affordable to run on every check.
    doNotFollow: {
      path: "node_modules",
    },
    // packages/module-boundaries/src/__tests__/fixtures is a synthetic mini-repo (its own fake
    // modules/services/packages, even its own fake node_modules/@earendil-works/pi-agent-core)
    // that module-boundaries.unit.test.ts cruises in isolation, remapping it to a repo root of
    // its own via checkModuleBoundaries's `baseDir`. Scanned in place here instead, its nested
    // real path (packages/module-boundaries/src/__tests__/fixtures/packages/agent-runtime/...)
    // defeats rules anchored on a literal top-level path, so it must stay out of this run.
    exclude: {
      path: "^packages/module-boundaries/src/__tests__/fixtures/",
    },
  },
};
