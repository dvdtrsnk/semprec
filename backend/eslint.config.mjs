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
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Type-aware linting is what makes `no-floating-promises` and `no-misused-promises`
      // possible, and in a codebase built on a job queue, IMAP IDLE connections and pooled
      // transactions those are the two rules worth the slower lint run. Two families of the
      // preset are switched off because this codebase violates them structurally rather than
      // accidentally, and leaving them on would mean ~500 inline disables:
      //
      //   `require-await` (274): async functions with no await are deliberate here — a port
      //   implementation matches its interface's Promise-returning signature whether or not
      //   that particular implementation needs to await anything (see the mail transports and
      //   the test fakes). Narrowing the signature per-implementation is the opposite of what
      //   the interface exists for.
      //
      //   `no-unsafe-*` (233): `pg`'s `QueryResult.rows` is `any[]`, so every store function
      //   trips these at the point it maps a row. The real fix is a typed row layer at the
      //   `pg` boundary, not a disable comment per query — until that exists, the rules would
      //   report the same known gap hundreds of times and drown the findings that are new.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
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
    // Config and tooling files live outside every package's tsconfig `include`, so the
    // type-aware rules have no program to consult and error out on them.
    files: ["**/*.cjs", "**/*.mjs", "*.config.ts", "**/scripts/**"],
    ...tseslint.configs.disableTypeChecked,
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
