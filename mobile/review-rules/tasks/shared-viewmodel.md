Check the shared `ScreenViewModel` contract for every changed or added screen
ViewModel, for `ScreenViewModel` itself and for the factory and SDK that create
them. Rule ID: `SHARED-VM`.

1. A ViewModel that imports UI or navigation API, or holds a native router, a
   platform type or a context — high: shared code runs in both apps and must
   not decide how either of them presents or navigates.
2. Mutable state (a `var` property or a mutable collection in a state class), an
   action or effect that is not a sealed interface, a one-time event modelled
   as state so it replays when the screen collects again, or lasting state
   modelled as an effect so a screen that starts later never sees it — medium;
   high when navigation can fire twice or be lost.
3. Work that outlives `close()`: launched outside `viewModelScope` or in a scope
   nothing cancels, an effect emitted or state changed after `close()`, an
   action that still starts work on a closed ViewModel (the screen ViewModels
   return early when `isClosed`), or a `close()` that is no longer idempotent —
   high.
4. A change to `ScreenViewModel` that alters what both native hosts rely on —
   the unlimited effect channel that delivers effects in emission order, each
   to at most one collector and never replayed, effects waiting while nobody
   collects, the state replaying its latest value, what `close()` and
   `onCleared()` end, effects emitted before closing still handed out — without
   `ScreenViewModelTest` covering the new behavior and the hosts that depend on
   it updated — high. The hosts are `CollectEffects` in
   `mobile/android/core/ui/`, which collects on `Dispatchers.Main.immediate`,
   and the CoreKit bridges with `EffectQueue` in
   `mobile/apple/Modules/Core/CoreKit/Sources/`; together they deliver every
   effect emitted on the main thread exactly once.
5. `HomeSDK` or `HomeViewModelFactory` returning one ViewModel instance from
   several calls, caching ViewModels, or a screen ViewModel constructor made
   public so code other than the factory can create it — medium: each caller
   owns the ViewModel it gets and closes it, so a shared instance is closed
   under another screen.
6. Text a user reads — a message, a label, a formatted title — in a state, an
   effect or anywhere else in shared code, instead of a typed value the apps
   localize (a phase, a `FailureKind`, an ordinal) — medium: it bypasses the
   English and Czech resources of both apps.
7. An `emit` that can run off the main thread — inside a `withContext` or a
   `launch` on another dispatcher (`Dispatchers.Default`, `Dispatchers.IO`), or
   from a callback another thread calls — medium: the hosts deliver exactly
   once only what is emitted on the main thread, and on Android an effect
   emitted elsewhere can be lost when the screen stops in the window between
   hand-off and resume.

A branch without a test is a finding of `tasks/correctness.md`, not of this
task. Not findings: a ViewModel emitting an effect that the native owner maps
to a router call; different visual presentation of the same state on the two
apps.
