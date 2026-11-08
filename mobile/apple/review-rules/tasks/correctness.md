Check for correctness bugs and gaps:

1. Force-unwrap (`!`) or force-try on a value that is not provably safe at
   that point — high, critical if it can be reached from untrusted/external
   input (network response, user input).
2. A retain cycle: a closure or `Task` capturing `self` strongly across an
   async boundary where the object may already be gone by completion — high.
3. UI state (`@Published`, `@State`, view model properties driving SwiftUI)
   mutated off the main actor — high.
4. An edge case the linked issue's Task explicitly calls out (e.g. a
   stated fallback, a named error condition) that the diff does not
   actually handle — high.
5. Dead code, an unused import, or a variable/parameter that is never read
   — low.
6. A `switch` with a `default` case over one of the app's own enums, or over a
   Kotlin enum or sealed type in a bridge — medium: a case added later compiles
   into the default instead of failing the build where it must be handled.
7. New behavior without a test that fails when it is wrong — medium: a bridge
   mapping branch without a `SharedMappingTests` case that builds the Kotlin
   value, a bridge's state relay, effect path, retry or lease without a
   `SharedScreenModelTests` case against the real Kotlin ViewModel, a feature
   ViewModel's state, intent or routing without a test over a scripted model,
   a failure message without a `FailureMessageTests` case, a router or a
   change to `NavigationContext` or `NavigatorStackAdapter` without a
   `NavigationTests` case, a change to how `AppScene` registers a stack,
   presents a destination or provides its view without an
   `AppSceneNavigationTests` case, or a new user flow that `SmokeFlowTests`
   (`SemprecUITests`) does not walk.
8. A `swiftlint:disable` without a stated reason, or a rule relaxed or removed
   in `.swiftlint.yml` without the Task calling for it — medium: every module
   is held to that configuration.
9. A user-visible string — a label, a message, an accessibility label — that
   does not come from the module's `Localizable.xcstrings` (text written into
   Swift, such as `Text(verbatim:)` or a `String` literal shown as it is), a
   key without a translated Czech value, a message assembled from separately
   translated fragments, or a `FailureKind` mapped to the wrong `failure.*` key
   — medium: the Czech user then sees English, or a sentence whose word order
   cannot be translated.
