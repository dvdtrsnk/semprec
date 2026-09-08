// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: {
      react: {
        version: "19.2",
      },
    },
    rules: {
      // `eslint-plugin-react-hooks`'s "recommended" preset (v7) is the full React Compiler
      // rule set (static-components, set-state-in-effect, use-memo, immutability, ...) meant
      // for compiler-readiness checks, not general hook-quality linting — it flags several
      // idiomatic, intentional patterns already in this codebase (e.g. resetting state in a
      // `useEffect` keyed on a changed resource) that would need real architectural rewrites
      // to satisfy, not simple local fixes. We keep only the two long-standing, stable rules.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Leading-underscore escape hatch for intentionally-unused params/destructures
      // (e.g. interface implementations that ignore an argument) is an established
      // pattern; enforcing it narrowly instead of a blanket allow.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["vite.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
);
