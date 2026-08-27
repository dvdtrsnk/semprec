Check for correctness bugs and gaps:

1. Force-unwrap (`!`) or force-try on a value that is not provably safe at
   that point — high, critical if it can be reached from untrusted/external
   input (network response, user input).
2. A retain cycle: a closure or `Task` capturing `self` strongly across an
   async boundary where the object may already be gone by completion — high.
3. UI state (`@Published`, `@State`, view model properties driving SwiftUI)
   mutated off the main actor — high.
4. An edge case the linked issue's Zadani explicitly calls out (e.g. a
   stated fallback, a named error condition) that the diff does not
   actually handle — high.
5. Dead code, an unused import, or a variable/parameter that is never read
   — low.
