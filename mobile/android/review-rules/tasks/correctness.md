Check for correctness bugs and gaps:

1. `!!`, an unchecked `as`, or `requireNotNull`/`error()` on a value that is not
   provably safe at that point in production code — high, critical if it can
   be reached from untrusted or external input (an intent, a saved-state
   value, a navigation argument a route does not guarantee). An unchecked
   generic read such as `SavedStateHandle.get<List<String>>` is an unchecked
   `as`. In test code, the same on a value that did not come from the code's
   own types — medium: rule 6 of `.bb/AGENTS.md` binds tests too, because test
   code is copied into production code.
2. An exception caught and swallowed, or turned into success, without being
   surfaced — high.
3. A `when` over a sealed or enum type with an `else` branch — medium: a case
   added later compiles into that branch instead of failing the build where it
   must be handled.
4. An edge case the linked issue's Task explicitly calls out (e.g. a stated
   fallback, a named error condition) that the diff does not actually handle —
   high.
5. New behavior without a test that fails when it is wrong — medium: an effect
   mapping without a router test (`HomeRouterTest`, `SettingsRouterTest`), a
   failure mapping without a `FailureMessageTest` case, a navigation command
   without `SceneNavigationTest` and `QueuedNavigationTest` cases, a change to
   how `CollectEffects` collects without a `CollectEffectsTest` case, a new
   route argument without a case for an id such as `"null"` (`HomeStackTest`,
   `SmokeFlowTest`), a change to what `MainActivity` keeps of its launch or new
   intent without a `LaunchIntentTest` case, or a new screen flow the
   instrumented `SmokeFlowTest` does not walk.
6. A `@Suppress` without a one-line reason beside it, or a lint check disabled
   or `warningsAsErrors`/`checkDependencies` turned off in
   `app/build.gradle.kts` without the Task calling for it — medium: every
   Android module is held to that configuration.
7. A user-visible string — a label, a message, a content description — written
   into Kotlin instead of the module's `res/values/strings.xml`, a string
   without its Czech translation in `res/values-cs/strings.xml`, a message
   assembled from separately translated fragments, or a `FailureKind` mapped to
   the wrong `failure_*` string — medium: the Czech user then sees English, or
   a sentence whose word order cannot be translated.
8. Dead code, an unused import or resource, or a variable/parameter that is
   never read — low.
