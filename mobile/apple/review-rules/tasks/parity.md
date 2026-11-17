Check that the Apple app behaves like the Android app for the same shared
input. Both render the same shared ViewModels, so their business outcomes are
equal by construction; the risk is in what each app writes by hand on top: which
shared state shows content, empty, loading or an error, whether retry is
offered, which message a `FailureKind` gets, which destination or sheet an
effect opens, and the copy and test identifiers. For every changed handler,
read its Android counterpart at the pull request's head. Rule ID:
`PARITY-BEHAVIOR`.

Where the counterparts live (Apple under `mobile/apple/`; Android under
`mobile/android/`, where `...` stands for the module's Kotlin package
directories below `src/main/kotlin/`):

- Home and Detail screens:
  `Modules/Features/Home/Sources/Layers/PresentationLayer/Screens/HomeScreen/`
  and `.../DetailScreen/`, with the bridges
  `Modules/Core/CoreKit/Sources/Shared/SharedHomeScreenModel.swift` and
  `SharedDetailScreenModel.swift` ↔ `feature/home/.../presentation/screen/home/`
  and `.../screen/detail/`.
- Failure messages:
  `Modules/Features/Home/Sources/Extensions/FailureKind+Message.swift` ↔
  `feature/home/.../presentation/FailureMessage.kt`.
- Settings and About:
  `Modules/Features/Settings/Sources/Layers/PresentationLayer/Screens/SettingsScreen/`
  and `.../AboutScreen/AboutScreen.swift` ↔
  `feature/settings/.../presentation/screen/settings/` and
  `.../screen/about/AboutScreenLayout.kt` (presented by
  `app/.../components/AboutSheet.kt`).
- Status views: `Modules/Core/DesignSystem/Sources/StatusView.swift` ↔
  `core/ui/.../StatusView.kt`.
- Effect routing: the feature ViewModels' `route(_:)`,
  `Projects/App/Sources/Routing/` and
  `Projects/App/Sources/Navigation/NavigationContext.swift` ↔
  `HomeRouter.handle`, `SettingsRouter.handle` and
  `app/.../navigation/SceneNavigation.kt` with `AppSceneState.execute`.
- Copy: each target's `Resources/Localizable.xcstrings` ↔ the matching
  module's `res/values/strings.xml` and `res/values-cs/strings.xml`.
- Test identifiers: `StatusIdentifiers`, `HomeIdentifiers`,
  `SettingsIdentifiers`, `AppIdentifiers` ↔ `StatusTestTags`, `HomeTestTags`,
  `SettingsTestTags`, `AppTestTags`.

1. For a state or effect the shared ViewModel can produce, the two apps'
   existing handlers give a different functional outcome — a different status,
   retry offered on one app only, a different message for the same
   `FailureKind`, a different destination or presentation for the same effect,
   a different action sent for the same tap — medium. A `default` branch is a
   handler. Cite both locations and the shared state or effect. Both apps push a
   detail for every `HomeEffect.OpenDetail` except the detail of the same id
   already on top (`NavigationContext.push` with `StackNavigating.top` ↔
   `AppSceneState.execute`), so a repeated effect opens one detail on each, and
   another item's detail stacks on both; a change that drops or alters that on
   one app only is this item.
2. A copy key whose English or Czech text, or whose placeholders' meaning and
   order, differ from the Android string of the same name — medium. The
   placeholder syntax differs by platform (`%lld` ↔ `%1$d`, `%1$@` ↔ `%1$s`)
   and is not a finding; the architecture check compares the key sets and that
   every key has a non-empty English and Czech value, not the text itself.
3. An accessibility identifier whose value differs from the Android test tag of
   the same element, or an asserted or interactive element that has an
   identifier on one app only — medium. `detail.back` exists only on Android,
   because this app uses the system back button; `HomeIdentifiers` documents
   it.

Not findings: a counterpart the Android app does not have yet (say which side
is missing instead of reporting an inconsistency); a different fallback for a
state the shared ViewModel cannot produce (cite the shared code that rules it
out); the platform's own presentation — the About sheet with its Done button
against the Android bottom sheet, the system back button against Android's
top-bar back arrow — accessibility wording, equivalent localized text,
spacing, colors and animations.
