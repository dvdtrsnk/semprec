Check for correctness bugs and gaps in shared Kotlin, the build scripts and
`scripts/`:

1. `!!`, an unchecked `as`, or `error()`/`require…`/`check…` on a value that is
   not provably safe at that point in production code — high, critical if it
   can be reached from untrusted or external input. In test code, a `!!` or an
   unchecked `as` or `get<T>` on a value that did not come from the code's own
   types — medium: rule 6 of `.bb/AGENTS.md` binds tests too, because test code
   is copied into production code.
2. An exception caught and turned into success, empty content, or a
   `FailureKind` the caught exception does not prove — high. An unexpected
   failure ends in the error phase with `failure = null`, as `HomeViewModel`
   and `DetailViewModel` do; only a failure the code recognizes becomes a typed
   kind.
3. A `when` over a sealed or enum type with an `else` branch — medium: a case
   added later compiles into that branch instead of failing the build where it
   must be handled.
4. An edge case the linked issue's Task explicitly calls out (e.g. a stated
   fallback, a named error condition) that the diff does not actually handle —
   high.
5. A new or changed ViewModel branch, use-case decision or repository behavior
   without a `commonTest` case that fails when it is wrong — medium. The
   existing tests in `shared/presentation/src/commonTest/` cover every phase,
   each action-to-effect mapping, retry superseding the running load, a
   superseded or closed load whose repository call answers late never
   publishing (`FakeRepository.Behavior.Late`, with `lateAnswers` proving the
   answer came), an unexpected exception, `close()` and an action after it, and
   clearing the owning `ViewModelStore` without `close()` (`ViewModelStore.provide`)
   and an action after that; a new screen is held to the same set.
6. A test that waits on real time (`delay` outside the test scheduler,
   `Thread.sleep`, `runBlocking` around a suspend call under test) or that
   passes without the coroutine it asserts on having run — medium: it fails at
   random or proves nothing. The shared tests use `runTest`, and the ViewModel
   tests install the `StandardTestDispatcher` of `MainDispatcherTest`
   (`shared/presentation/src/commonTest/.../PresentationTestSupport.kt`) as the
   main dispatcher.
7. A `@Suppress` without a one-line reason beside it — medium: it silences a
   check every other module is held to, and the next reader cannot tell a
   deliberate exception from an accident.
8. A comment or KDoc that states behavior the code does not have — medium: the
   KDoc of `ScreenViewModel`, `HomeSDK` and the use cases is the contract the
   native apps are written against.
9. Dead code, an unused import, or a variable/parameter that is never read —
   low.
