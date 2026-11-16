Check for correctness bugs and gaps:

1. `any` or an unchecked cast at a module boundary (parsed external input, a raw DB
   row, an API request/response payload) — high.
2. An unhandled promise rejection, or a `.catch`/`try` that swallows an error without
   logging or surfacing it — high.
3. A new behavior or acceptance criterion with no test of that behavior — medium. A
   branch without its own test, or an untested defensive branch, is not a finding.
4. An edge case the linked issue's Task section explicitly calls out (e.g. a stated
   fallback, a named error condition) that the diff does not actually handle — high.
5. A Czech canonical key (`databases.key`, property key, select-option value, settings
   key) — high; keys are English camelCase, view types kebab-case. A hardcoded
   user-facing label instead of an i18n key — medium.
6. Dead code, an unused import, or a variable/parameter that is never read — low.
