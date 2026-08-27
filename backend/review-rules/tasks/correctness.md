Check for correctness bugs and gaps:

1. `any` or an unchecked cast at a module boundary (parsed external input, a raw DB
   row, an API request/response payload) — high.
2. An unhandled promise rejection, or a `.catch`/`try` that swallows an error without
   logging or surfacing it — high.
3. New choke-point behavior (a new endpoint, a new item type, a new automation
   transition) added with no accompanying test — medium.
4. An edge case the linked issue's Zadani explicitly calls out (e.g. a stated
   fallback, a named error condition) that the diff does not actually handle — high.
5. Dead code, an unused import, or a variable/parameter that is never read — low.
