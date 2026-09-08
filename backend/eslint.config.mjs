// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // Leading-underscore escape hatch for intentionally-unused params/destructures
      // (e.g. interface implementations that ignore an argument) is an established
      // pattern across the workspace; enforcing it narrowly instead of a blanket allow.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain Node CommonJS config files (module.exports/require) — not part of the
    // NodeNext/ESM `src/` codebase, so the ESM-oriented require-imports rule doesn't apply.
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  eslintConfigPrettier,
);
