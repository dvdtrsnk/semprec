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
    // `doNotFollow` (not `exclude`) so a rule still matches a direct edge into a node_modules package without
    // depcruise recursing into its dependency tree.
    doNotFollow: {
      path: "node_modules",
    },
    // A synthetic mini-repo that module-boundaries.unit.test.ts cruises with its own `baseDir`; scanned in place, its
    // nested paths defeat rules anchored on top-level paths.
    exclude: {
      path: "^packages/module-boundaries/src/__tests__/fixtures/",
    },
  },
};
