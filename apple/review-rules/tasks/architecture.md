Check for architecture and ownership violations:

1. A view or view model bypassing the shared networking/API layer to talk to
   the backend directly — high severity.
2. Platform-specific branching (`#if os(iOS)` / `#if os(macOS)`) used where a
   shared implementation would work identically on both — medium severity
   (flag it as unnecessary duplication).
3. New abstraction, config flag, or generalization not required by the
   linked issue's Zadani — medium severity (flag it as scope creep, not a
   style nitpick).
4. A module/feature reaching into another module's internals instead of its
   declared public interface — high severity.
