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
    exclude: {
      path: "node_modules",
    },
  },
};
