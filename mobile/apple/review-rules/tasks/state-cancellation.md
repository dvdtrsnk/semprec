Check cancellation, task lifetime and state ownership in the Swift code.
Rule IDs: `ASYNC-CANCELLATION`, `STATE-LIFETIME`. UI state mutated off the main
actor is a finding of `tasks/correctness.md`, not of this task.

1. Swift task cancellation (`CancellationError`, `Task.isCancelled`) or a Kotlin
   `CancellationException` caught and shown as an error or mapped to a failure
   state — `ASYNC-CANCELLATION`, high.
2. A `Task`, an observation loop or a `relay` iteration that outlives its owner
   — not ended by the screen's `.task` or the owner's `deinit` — while it keeps
   doing work — `ASYNC-CANCELLATION`, high; medium when it only waits.
3. A stale result applied after a newer request or after the owner was
   released — `ASYNC-CANCELLATION`, high when the changed code can reach it,
   otherwise low.
4. A stateful dependency created inside `body`, `@ObservedObject` where the view
   owns the object, or a Factory registration that shares a screen or session
   object between scenes (`SceneContainer` is created per scene) —
   `STATE-LIFETIME`, medium; high with a demonstrated leak between screens or
   windows.
5. `@unchecked Sendable` or `nonisolated(unsafe)` added without the
   synchronization or the invariant that makes it safe — `STATE-LIFETIME`,
   medium: it switches off the strict concurrency checking every target builds
   with. `SharedViewModelLease`, the one `@unchecked Sendable` type today,
   guards its state with an `NSLock`.

Name the owner, the transition (dismissal, a new observer, release) and the
failure. Not findings: constructor injection; a stateless service shared
between scenes; `@StateObject` at the composition boundary.
