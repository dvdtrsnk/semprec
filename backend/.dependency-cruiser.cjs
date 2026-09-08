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
  },
};
