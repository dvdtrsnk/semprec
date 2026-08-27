Check for correctness bugs and gaps:

1. `any` or an unchecked cast at a module boundary (API response, form
   input, route param) — high.
2. An unhandled promise rejection, or a `.catch`/`try` that swallows an
   error without logging or surfacing it to the user — high.
3. New API-backed behavior (a new form, a new data view) added with no
   accompanying test — medium.
4. An edge case the linked issue's Zadani explicitly calls out (e.g. a
   stated fallback, a named error condition) that the diff does not
   actually handle — high.
5. Dead code, an unused import, or a variable/parameter that is never read
   — low.
