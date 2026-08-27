Check for architecture and ownership violations:

1. A write to persisted state that bypasses the generic choke-point API (see rules.md)
   — critical severity, unless this PR's linked issue is the one introducing the
   choke-point itself.
2. Two different processes/modules writing to the same table or field without a
   documented ownership handoff — high severity.
3. A migration that is not additive/backward-compatible (drop, rename, type
   narrowing, `NOT NULL` without a default) on a table this PR did not just create —
   critical, unless the linked issue explicitly calls for a breaking change.
4. New abstraction, config flag, or generalization not required by the linked issue's
   Zadani — medium severity (flag it as scope creep, not a style nitpick).
5. A module reaching into another module's internals instead of its declared
   contract/exported interface — high severity.
