# Mobile architecture

This document describes the code under `mobile/` as it is today: placeholder
screens on a complete stack. The decisions behind it are the ADRs listed at the
end. Paths are relative to `mobile/`, except those under `docs/adr/` and
`.bb/skills/`, which are at the repository root.

## Layers

Kotlin Multiplatform owns everything from the screen ViewModels down. The UI is
native: Jetpack Compose on Android, and one SwiftUI codebase on Apple whose
targets build for iPhone, iPad and Mac (native macOS, not Mac Catalyst).

| Layer | Where | Holds |
| --- | --- | --- |
| Core | `shared/core` | `FailureKind` (`UNAVAILABLE`, `INVALID_DATA`): the expected failures, carried as values |
| Domain | `shared/domain` | `PlaceholderItem`, the `PlaceholderRepository` port, `RepositoryResult` (content or an expected failure), the use cases `LoadPlaceholderItems` (rejects blank or duplicate ids, orders by ordinal then id) and `LoadPlaceholderItem` (an item with another id than requested is invalid data) |
| Data | `shared/data` | `InMemoryPlaceholderRepository`: `item-1` to `item-5` with ordinals 1 to 5; it never fails |
| Presentation | `shared/presentation` | `ScreenViewModel`, the screen ViewModels `HomeViewModel`, `DetailViewModel` and `SettingsViewModel` with their state, action and effect types, and `HomeViewModelFactory` |
| SDK | `shared/umbrella` | `HomeSDK`, the composition root, built into the `SharedSDK` Apple framework |
| Android UI | `android/core/ui`, `android/feature/home`, `android/feature/settings`, `android/app` | theme and shared components; one module per feature; the app, which composes everything and owns navigation |
| Apple UI | `apple/Modules/Core/{CoreKit,DesignSystem,Dependencies}`, `apple/Modules/Features/{Home,Settings}`, `apple/Projects/App` | the Swift side of the shared ViewModels, theme and shared views, the dependency container; one module per feature; the app, which composes everything and owns navigation |

Kotlin packages follow the modules: `cz.semprec.app.core`, `.domain`, `.data`,
`.presentation` and `.sdk` in `shared/`; `cz.semprec.app` (the app),
`cz.semprec.app.core.ui`, `cz.semprec.app.feature.home` and
`cz.semprec.app.feature.settings` in `android/`. No `commonMain` source imports a
platform API; its only AndroidX imports are `ViewModel` and `viewModelScope` from
the multiplatform `androidx.lifecycle:lifecycle-viewmodel` artifact.

### Gradle modules

Every shared module applies the `semprec.kmp` convention plugin (targets `jvm`,
`androidTarget`, `iosArm64`, `iosSimulatorArm64`, `macosArm64`). Android modules
apply `semprec.android.compose` (a Compose library) or
`semprec.android.application`. The project dependencies, from the `build.gradle.kts`
files:

```
:shared:core
:shared:domain             -> :shared:core (api)
:shared:data               -> :shared:domain
:shared:presentation       -> :shared:core (api), :shared:domain
:shared:umbrella           -> :shared:core (api), :shared:presentation (api), :shared:domain, :shared:data
:android:core:ui           -> (no project)
:android:feature:home      -> :android:core:ui, :shared:presentation
:android:feature:settings  -> :android:core:ui, :shared:presentation
:android:app               -> :android:core:ui, :android:feature:home, :android:feature:settings,
                              :shared:presentation, :shared:umbrella
```

Presentation depends on domain and not on data; only the umbrella sees data. The
`SharedSDK` framework (`shared/umbrella/build.gradle.kts`: dynamic, for
`iosArm64`, `iosSimulatorArm64` and `macosArm64`) exports, of its dependencies,
only presentation and core, so the public API of domain and data is not exported as
a whole. Kotlin/Native still puts into the header every type that a public exported
declaration references, from any module and over `api` and `implementation` alike,
so domain and data types stay out of the Swift API only because nothing public and
exported references them: the ViewModel constructors and `toHomeItem()` are
`internal`, `HomeSDK` keeps its repository and factory `private`, and
`HomeViewModelFactory` is `@HiddenFromObjC`. SKIE generates the Swift API of the
framework (Swift enums for Kotlin enums, `onEnum(of:)` for sealed types, async
sequences for flows).

### Tuist targets

Every target uses `SemprecProject.destinations` (`[.iPhone, .iPad, .mac]`) and
`SemprecProject.deploymentTargets` (iOS 26.0, macOS 26.0), arm64 only
(`ARCHS` from `ProjectConfiguration.architectures`, which the Swift packages in
`apple/Tuist/Package.swift` use too), Swift 6 with complete strict concurrency, and
the configurations Debug and Release
(`apple/Tuist/ProjectDescriptionHelpers/SemprecProject.swift`). The one exception
is the XCUITest target `SemprecUITests`, which builds for iPhone and iPad only
(`destinations: [.iPhone, .iPad]`, `.iOS(ProjectConfiguration.iosMinimum)`):
on macOS XCUITest needs the Accessibility permission to drive the app, which a
build machine does not grant. The dependencies, from the `Project.swift` files:

```
CoreKit           -> SharedSDK (search path and -framework; built by its "Build the Kotlin framework" phase)
DesignSystem      -> (nothing)
Dependencies      -> CoreKit, FactoryKit
HomeFeature       -> CoreKit, DesignSystem
SettingsFeature   -> CoreKit, DesignSystem
Semprec (the app) -> CoreKit, Dependencies, HomeFeature, SettingsFeature, NavigatorUI

CoreKitTests          -> CoreKit (its import of SharedSDK links the framework through autolinking)
HomeFeatureTests      -> HomeFeature, CoreKit
SettingsFeatureTests  -> SettingsFeature, CoreKit
SemprecTests          -> Semprec, NavigatorUI
SemprecUITests        -> Semprec (the app under test; it imports none of its modules)
```

`SemprecUITests` finds elements by the identifiers the app and the features
declare, so its sources are `Projects/App/UITests/**` plus three files it
compiles from the targets it does not link: `Projects/App/Sources/AppIdentifiers.swift`,
`Modules/Features/Home/Sources/HomeIdentifiers.swift` and
`Modules/Features/Settings/Sources/SettingsIdentifiers.swift`. `ARCH-APPLE`
checks the imports of those files against the policy of `SemprecUITests`.

Only CoreKit's sources and its tests import `SharedSDK`: the sources as
`@preconcurrency internal import SharedSDK` in
`apple/Modules/Core/CoreKit/Sources/Shared/`, and `CoreKitTests` to build Kotlin
values for the mapping tests. Features and the app use CoreKit's Swift types, and
the SwiftLint rule `kmp_framework_outside_corekit` reports an import anywhere else,
other test targets included. `FactoryKit` is imported only by Dependencies, which
re-exports it, and `NavigatorUI` only by the app and its tests (`SemprecTests`,
which drive the app's NavigatorUI stacks). `apple/Workspace.swift` declares two
shared schemes. `Semprec` builds the app and runs the four unit test bundles, on
macOS and on an iOS simulator. `SemprecUITests` builds the app and runs the
XCUITest bundle, on an iOS simulator only; it is a scheme of its own so that the
`Semprec` scheme's tests keep running on macOS without the Accessibility
permission.

## Screen ViewModels

### The shared contract

`ScreenViewModel<State, Action, Effect>`
(`shared/presentation/src/commonMain/kotlin/cz/semprec/app/presentation/ScreenViewModel.kt`)
extends the multiplatform AndroidX `ViewModel`:

- `state: StateFlow<State>`: one immutable value; a collector receives the latest
  value first. Subclasses replace it with `update`.
- `onAction(action)`: the only input; the hosts call it on the main thread.
- `effects: Flow<Effect>`: one-time requests to the native owner. It is a
  `Channel(UNLIMITED)` read through `receiveAsFlow()`. It delivers effects in
  emission order, each to at most one collector, and never replays one; effects
  emitted while nobody collects wait for the next collector. A collector cancelled
  after the channel handed it an effect but before it resumed drops that effect
  (the prompt cancellation of kotlinx.coroutines), so the flow alone guarantees at
  most once. The hosts collect where that cannot happen: Android's `CollectEffects`
  on `Dispatchers.Main.immediate`, where an effect emitted on the main thread is
  processed before any lifecycle event can cancel the collector, and each Apple
  CoreKit bridge once for its whole life through an `EffectQueue`. So every effect
  emitted on the main thread is delivered exactly once while the ViewModel
  (Android) or the bridge (Apple) lives. Subclasses send with `emit`, only on the
  main thread: from `onAction` or from work in `viewModelScope`, which runs on
  `Dispatchers.Main.immediate`. An effect emitted on another thread keeps only the
  at-most-once guarantee.
- `close()`: cancels `viewModelScope` and closes the effect channel; calling it
  again changes nothing. When Android's `ViewModelStore` clears the instance, the
  scope is cancelled and `onCleared()` closes the channel, so clearing ends the
  same. Afterwards `isClosed` is `true`, the state keeps its last value, an effect
  emitted is dropped, and the effect flow still hands out the effects emitted
  before and then completes.

| ViewModel | State | Actions | Effects |
| --- | --- | --- | --- |
| `HomeViewModel` | `HomeState(phase: LOADING, CONTENT, EMPTY or ERROR; items: List<HomeItem>; failure: FailureKind?)` | `HomeAction.Retry`, `HomeAction.SelectItem(id)` | `HomeEffect.OpenDetail(id)` |
| `DetailViewModel(itemId)` | `DetailState(phase: LOADING, CONTENT, NOT_FOUND or ERROR; item: HomeItem?; failure: FailureKind?)` | `DetailAction.Retry` | none (`Nothing`) |
| `SettingsViewModel` | `SettingsState(rows: List<SettingsRow>)`, `SettingsRow.ABOUT` | `SettingsAction.SelectRow(row)` | `SettingsEffect.ShowAbout` |

The constructors are `internal`. `HomeViewModelFactory` creates the ViewModels and
`HomeSDK` exposes `homeViewModel()`, `detailViewModel(itemId)` and
`settingsViewModel()`; every call returns a new instance that the caller owns.
`HomeViewModel` and `DetailViewModel` start loading in `init`; `Retry` cancels the
running load and starts over from `LOADING`. A `RepositoryResult.Failure` becomes
`ERROR` with its `FailureKind`, an exception other than cancellation becomes
`ERROR` with `failure = null`, and a `CancellationException` is rethrown, never
turned into a state. A superseded or closed load never publishes, also when its
repository call returns after the cancellation. `onAction` does nothing after
`close()` or clearing.

### Android: the ViewModelStore owns it

- `android/app/src/main/kotlin/cz/semprec/app/AppModule.kt` binds one `HomeSDK` and
  a Koin `viewModel { }` per screen (the detail takes its `itemId` as a parameter);
  `SemprecApplication` starts Koin with it.
- `HomeTabHost.kt` and `SettingsTabHost.kt`, next to it, call `koinViewModel()`
  inside each `NavHost` destination, so each ViewModel lives in the
  `ViewModelStore` of its back-stack entry and is cleared when the entry leaves
  the back stack. Android code never calls `close()`.
- A feature's `<X>Screen` collects `state` with `collectAsStateWithLifecycle()` and
  hands effects to `CollectEffects` (`android/core/ui`), which collects only while
  the lifecycle is at least `STARTED`, on `Dispatchers.Main.immediate` inside
  `repeatOnLifecycle` (`collectWhileStarted`), and passes each effect to the
  feature router's `handle(effect)`. A collector suspended there resumes inside the
  emitting `trySend`, before the main looper can run a queued `ON_STOP`; Compose's
  own dispatcher always posts the resume and would leave that window open.
  `<X>ScreenLayout` takes the state and callbacks only and has private previews.
  `DetailScreen` collects only the state.

### Apple: a CoreKit bridge owns it

Paths in the first four items are relative to `apple/Modules/Core/CoreKit/`.

- CoreKit's `ScreenModel<State, Action, Effect>` (`Sources/ScreenModel.swift`)
  is the Swift face of one shared ViewModel: a synchronous `state`, `states()`,
  `effects()` and `send(_:)`. Its state, action and effect types are Swift values
  in `Sources/Models/` (`HomeState`, `DetailState`, `SettingsState`, ...), so a
  feature never sees a Kotlin type.
- The bridges `SharedHomeScreenModel`, `SharedDetailScreenModel` and
  `SharedSettingsScreenModel` (`Sources/Shared/`) hold the Kotlin ViewModel and a
  `SharedViewModelLease { viewModel.close() }`, which runs its release at most
  once; each bridge closes its lease in `deinit`. Each maps between the Kotlin and
  the Swift values with internal static functions under `// MARK: - Mapping`
  (`state(_:)`, `action(_:)` and, with effects, `effect(_:)`; shared values in
  `Sources/Shared/SharedValues.swift`), and `send(_:)` is
  `viewModel.onAction(action: Self.action(action))`.
- `states()` relays the Kotlin `StateFlow` through a new SKIE iterator for each
  call (`Sources/Shared/Relay.swift`); cancelling the observing task ends it.
- Effects: the Home and Settings bridges each create one
  `EffectQueue(collecting: viewModel.effects, …)`
  (`Sources/Shared/EffectQueue+SharedFlow.swift`), a main-actor task that collects
  the Kotlin effect flow for the ViewModel's whole life; closing the Kotlin
  ViewModel completes the flow and finishes the queue. `effects()` returns
  `effectQueue.stream()` (`Sources/EffectQueue.swift`): only the newest stream
  takes effects, and only while its task is not cancelled; each effect is handed
  out once, in order, and an effect nobody has taken waits for the next stream.
  Observers never iterate the Kotlin flow themselves, because a SKIE iterator
  keeps collecting until it is deallocated, and an effect it took after its
  observer stopped would never reach Swift. The detail's `effects()` is an empty,
  finished stream (Kotlin `Nothing` becomes Swift `Never`).
- `SharedScreenModelFactory` owns one `HomeSDK` and creates a new bridge per call.
  `SceneContainer` (Dependencies, a Factory `ManagedContainer`) registers it as
  `screenModelFactory`, and `AppComposition`, which each window's `AppScene` holds
  as a `@StateObject`, resolves it. Windows share neither the SDK nor navigation,
  and a closed window releases its composition and the `HomeSDK` behind it
  (`SceneLifetimeTests`; see Navigation for the root navigator).
- `HomeScreenFactory.home(makeModel:router:)` builds
  `HomeScreen(viewModel: HomeViewModel(model: makeModel(), router: router))`. The
  screen's initializer takes the ViewModel as an `@autoclosure` and hands it to
  `StateObject(wrappedValue:)`, so SwiftUI evaluates it, and creates the Kotlin
  ViewModel, once per screen identity. `@State` would evaluate its initial value
  on every initialization of the view, which is why the feature ViewModels are
  `ObservableObject`s held in `@StateObject` rather than `@Observable` classes.
- The feature ViewModels (`HomeViewModel`, `DetailViewModel`, `SettingsViewModel`;
  internal `@MainActor final class`es) read `model.state` in `init` and run
  `observe()` in the screen's `.task`. `ScreenModel.observe(onState:onEffect:)`
  (`observe(onState:)` for the detail) applies states and routes effects until
  that task is cancelled. Releasing the feature ViewModel releases the bridge,
  whose `deinit` closes the Kotlin ViewModel.
- Previews and feature tests use `ScriptedScreenModel` (`ScriptedHomeScreenModel`,
  `ScriptedDetailScreenModel`, `ScriptedSettingsScreenModel`), which never starts
  the Kotlin runtime and hands out effects through the same `EffectQueue`.

| | Android | Apple |
| --- | --- | --- |
| Created by | `koinViewModel()` in the `NavHost` destination, from `HomeSDK` | `SharedScreenModelFactory`, from `HomeSDK`, inside the screen's `@StateObject` autoclosure |
| Owner | the `ViewModelStore` of the back-stack entry | the feature `ObservableObject`, through the CoreKit bridge |
| State | `collectAsStateWithLifecycle()` | `model.state` in `init`, then `observe()` in `.task` |
| Effects | `CollectEffects` while `STARTED`, on `Dispatchers.Main.immediate`, to the feature router | `observe()` in `.task`, to the feature router; in a bridge with effects, one collector fills its `EffectQueue` for the bridge's whole life |
| Closing | the store clears the instance | the bridge's `deinit` closes its `SharedViewModelLease`, which calls `close()` once |
| Previews and tests | layouts take plain state; router mapping unit tests | `ScriptedScreenModel` |

## Navigation

A shared ViewModel never navigates; it emits an effect. Each feature declares a
router and maps its screens' effects to it, and the app implements the routers and
owns every tab, stack and sheet. Navigation libraries are dependencies of the apps
and their tests only: `navigation-compose` (with `kotlinx-serialization-core` and
the serialization plugin for its type-safe routes) of `android/app`, `NavigatorUI`
of the Apple app target and of `SemprecTests`.

| | Android | Apple |
| --- | --- | --- |
| Router | `HomeRouter` (`showDetail(id)`, `closeDetail()`) and `SettingsRouter` (`showAbout()`) at the feature root, each with an `internal fun handle(effect)` | `HomeRouting` (`showDetail(itemId:)`) and `SettingsRouting` (`showAbout()`) in each feature's `Sources/Routing/`; the feature ViewModel maps effects in its private `route(_:)` |
| Implemented by | `SceneNavigation` (`android/app/.../navigation/SceneNavigation.kt`), whose `home` and `settings` objects queue `NavigationCommand`s | `AppHomeRouter` and `AppSettingsRouter` (`apple/Projects/App/Sources/Routing/`) over the window's `NavigationContext` |
| Stacks | one `NavHostController` per tab in `AppSceneState`; the selected tab and the About sheet are `rememberSaveable` state | one NavigatorUI `ManagedNavigationStack` per tab, registered in `NavigationContext` when it appears, under the scene's root `Navigator` in `AppScene`'s `@State`; the selected tab is `AppScene`'s `@State` (`TabView(selection:)`, `.home` unless `init(composition:selectedTab:)` names another) |
| Destinations | the type-safe routes `HomeRoute`, `DetailRoute(itemId)` and `SettingsRoute` (`AppRoutes.kt`), declared with `composable<T>`; each detail is a new entry, unless the detail of the same id is on top; About sets `aboutVisible`, which shows `AboutSheet` | `AppDestination` (`.detail(itemId:)`, `.about`), with the views from `.onNavigationProvidedView` in `AppScene`; each detail is pushed, unless the detail of the same id is on top |
| Back | the detail's top-bar arrow calls `closeDetail()` directly, which pops the top detail only; system Back on the Settings root selects Home | the system back button; the About sheet closes itself with `dismiss` |

**Android launch intent.** `MainActivity` is the exported launcher activity, so
any app can start it, or hand the running one a new intent, with whatever extras
and data it chooses. Navigation Compose reads such an intent itself: when a tab's
`NavHost` first sets its graph, its `NavHostController` runs
`handleDeepLink(activity.intent)`, which follows Navigation's deep-link extras
(`NavController.KEY_DEEP_LINK_IDS`, `KEY_DEEP_LINK_ARGS`,
`KEY_DEEP_LINK_EXTRAS`) to any destination they name, without checking the
sender, and a missing or mistyped `itemId` crashes the app in
`toRoute<DetailRoute>()`. The app declares no deep link, so `MainActivity`
replaces its intent, at the top of `onCreate` and before `super.onCreate`, on
every creation (a recreated activity gets the original intent again), with
`withoutLaunchContent()`: `cloneFilter()` without the data, which keeps the
action, categories, component, package and identifier and drops the extras, the
data and its type, the clip data, the selector and the flags. `onNewIntent`,
which a caller's `FLAG_ACTIVITY_SINGLE_TOP` reaches whatever the launch mode,
hands `super` and every new-intent listener only `withoutLaunchContent()` of the
new intent. A first
deep link has to be read from the original intent in `MainActivity` on purpose,
under its own ADR (`LaunchIntentTest`).

**Android command queue.** `SceneNavigation` is the activity's ViewModel.
`MainActivity` creates its `SavedStateHandle` from `CreationExtras` that hold only
the saved-state registry and `ViewModelStore` owners, without the activity's
default arguments (`DEFAULT_ARGS_KEY`, which carries the extras of the intent),
so the queue never depends on the intent even apart from the sanitizing above.
It keeps unacknowledged commands in a
`MutableStateFlow` mirrored into that handle (keys `pending_navigation` and
`next_navigation_sequence`).
`commands` delivers the oldest unacknowledged command and the next one only after
`acknowledge(sequence)`; a new collection starts again from the oldest
unacknowledged command, and it is meant for one collector at a time. `AppScene`
collects it only while `STARTED`, runs each command with the suspending
`AppSceneState.execute` and acknowledges it right after. A command for the Home
stack first selects the Home tab and waits until the Home `NavHost` has set its
graph (`homeStack.currentBackStackEntryFlow.first()`). A command that has not run
yet therefore survives a stopped scene, recreation and process death, and an
acknowledged command is never delivered again. The saved values are read untyped
and narrowed at start: a value of another type under either key, an entry that is
no `String` or no readable command, and an entry repeating a queued sequence are
dropped and the handle is rewritten without them; the next sequence is above every
queued one.

**Android routes.** A route argument is a non-null property of a `@Serializable`
route class, so an id comes back exactly as it went in (`"null"`, `""` and route
characters included). `Detail(id)` pushes a new `DetailRoute(id)` entry, with its
own `ViewModelStore` and `DetailViewModel`, and skips only a detail of the same id
already on top; it never uses `launchSingleTop`, which would keep the top entry's
`ViewModelStore` and hand the new detail the previous item's ViewModel. Back or
`closeDetail()` on a detail opened over another returns to that detail.

**Apple scene lifetime.** NavigatorUI keeps the destination provider of
`.onNavigationProvidedView` in the root navigation state for as long as that state
lives. `AppScene` therefore holds the root `Navigator` in its own `@State`, never in
`AppComposition`. Every closure it hands NavigatorUI calls static functions and
captures only the composition, never `self`, whose `@State` storage holds that
root state. The destination provider captures the composition weakly as well,
because on macOS AppKit kept a closed window's tab bar environment, root navigator
included, alive in `SceneLifetimeTests`, which checks that a closed scene releases
its composition and its screen model factory.

**Apple routing.** `NavigationContext` drops a route for a tab whose stack has
not registered yet. A stack's root registers each time it appears, through
`NavigationContext.register(_ navigator:for:)`, which keeps the
`NavigatorStackAdapter` already registered for the same navigator (the same
`navigator.id`), and with it what the adapter knows of the stack, and replaces
the stack of another navigator. `push(_:in:)` skips a
destination equal to the stack's `top`, as Android does, so a second tap that
arrives with the first opens the detail once, and the detail of another item
still stacks. NavigatorUI tells how many entries a path holds, not which, so
`NavigatorStackAdapter` remembers what it pushed and reconciles that with
`navigator.count`: Back, a back swipe and a pop remove entries from the end, so
its `top` stays right after them while it is the only code that appends to the
path, as it is in the app; an entry other code appended leaves `top` nil, and
the push goes through, until that entry is popped. An effect raised while a
screen is not observing (for example while the detail covers Home) waits in the
bridge's `EffectQueue` and is routed once when the screen observes again.

## Copy and localization

Shared state carries typed values only (phases, `FailureKind`, ordinals and ids),
never display text. Each platform renders them from its own resources, under the
same key:

- Android: resource name = key with `.` replaced by `_`, in `res/values/strings.xml`
  (English, the fallback) and `res/values-cs/strings.xml` of the module that
  renders it. The only key outside the table is `app_name`
  (`translatable="false"`).
- Apple: `Resources/Localizable.xcstrings` of the app, DesignSystem, HomeFeature
  and SettingsFeature, source language English, every key translated to Czech;
  read with `Text("key", bundle: .module)` or `String(localized:bundle:)` in the
  modules. Keys with arguments are formatted with `String(format:locale:)`, so the
  key stays the plain dotted name.

| Key | Android module | Apple module | English |
| --- | --- | --- | --- |
| `tab.home` | `android/app` | App | Home |
| `tab.settings` | `android/app` | App | Settings |
| `state.loading` | `android/core/ui` | DesignSystem | Loading… |
| `state.retry` | `android/core/ui` | DesignSystem | Try again |
| `home.title` | `android/feature/home` | HomeFeature | Home |
| `home.item.title` | `android/feature/home` | HomeFeature | Placeholder item `%1$d` (Apple `%lld`) |
| `home.empty` | `android/feature/home` | HomeFeature | There are no items yet. |
| `detail.title` | `android/feature/home` | HomeFeature | Item |
| `detail.description` | `android/feature/home` | HomeFeature | This screen shows one placeholder item. |
| `detail.notFound` | `android/feature/home` | HomeFeature | This item does not exist. |
| `detail.back` | `android/feature/home` | (none) | Back |
| `failure.unavailable` | `android/feature/home` | HomeFeature | The content is not available right now. |
| `failure.invalidData` | `android/feature/home` | HomeFeature | The content could not be read. |
| `failure.unexpected` | `android/feature/home` | HomeFeature | Something went wrong. |
| `settings.title` | `android/feature/settings` | SettingsFeature | Settings |
| `settings.row.about` | `android/feature/settings` | SettingsFeature | About |
| `about.title` | `android/feature/settings` | SettingsFeature | About Semprec |
| `about.description` | `android/feature/settings` | SettingsFeature | This app is a placeholder for the screens to come. |
| `about.version` | `android/feature/settings` | SettingsFeature | Version `%1$s (%2$s)` (Apple `%1$@ (%2$@)`) |
| `about.done` | `android/feature/settings` | SettingsFeature | Done |

`detail.back` is the content description of Android's top-bar back arrow; Apple
uses the system back button and has no such string. The Czech texts are in each
`values-cs/strings.xml` and in the catalogs' `cs` localizations.

- A failure maps `UNAVAILABLE` to `failure.unavailable`, `INVALID_DATA` to
  `failure.invalidData` and no kind to `failure.unexpected`, on the Home and the
  Detail screen: `failureMessage(failure)` in
  `android/feature/home/.../presentation/FailureMessage.kt`,
  `FailureKind.message(for:)` in
  `apple/Modules/Features/Home/Sources/Extensions/FailureKind+Message.swift`.
- An item's title is `home.item.title` with its ordinal.
- About shows `about.version` with the app's version name and build number:
  `AboutSheet` passes `BuildConfig.VERSION_NAME` and `BuildConfig.VERSION_CODE`
  into `AboutScreenLayout`, and `AppComposition` reads `CFBundleShortVersionString`
  and `CFBundleVersion` from `Bundle.main` for `SettingsScreenFactory.about`.
- Android packages only the `en` and `cs` translations, its libraries' included
  (`localeFilters`); the Apple app declares `CFBundleDevelopmentRegion` `en` and
  `CFBundleLocalizations` `en`, `cs`. Android lint (`warningsAsErrors`) fails on an
  untranslated or unused string.

## Test identifiers

Android `testTag` values equal Apple `accessibilityIdentifier` values. Each module
declares its own in one place.

| Identifier | Element | Android | Apple |
| --- | --- | --- | --- |
| `tab.home`, `tab.settings` | the tab items | `AppTestTags` (`android/app`) | `AppIdentifiers` (`apple/Projects/App`), on `Tab(...)` |
| `home.screen` | the Home screen | `HomeTestTags` | `HomeIdentifiers` |
| `home.item.<id>`, e.g. `home.item.item-1` | a list row | `HomeTestTags.HOME_ITEM_PREFIX` | `HomeIdentifiers.itemPrefix` |
| `detail.screen` | the detail screen | `HomeTestTags` | `HomeIdentifiers` |
| `detail.title` | the item's title on the detail | `HomeTestTags` | `HomeIdentifiers` |
| `detail.back` | the top-bar back arrow | `HomeTestTags` | none: the system back button (documented in `HomeIdentifiers`) |
| `settings.screen` | the Settings screen | `SettingsTestTags` | `SettingsIdentifiers` |
| `settings.row.about` | the About row | `SettingsTestTags` | `SettingsIdentifiers` |
| `about.screen` | the About content | `SettingsTestTags` | `SettingsIdentifiers` |
| `about.done` | the Done button | `SettingsTestTags` | `SettingsIdentifiers` |
| `state.loading`, `state.message`, `state.retry` | `StatusView`'s progress indicator, empty or failure message, and retry button | `StatusTestTags` (`android/core/ui`) | `StatusIdentifiers` (DesignSystem) |

Android sets `testTagsAsResourceId` on the scene's `Scaffold` and on `AboutSheet`
(a window of its own), so UIAutomator sees the tags as resource ids. The Apple
screens mark their container with `.accessibilityElement(children: .contain)`, so
the screen identifier does not hide the identifiers inside it. Android's
`SmokeFlowTest` and Apple's `SmokeFlowTests` (`SemprecUITests`, which compiles
`AppIdentifiers.swift`, `HomeIdentifiers.swift` and `SettingsIdentifiers.swift`)
find the elements by these values.

## Tests

| Kind | Where | Command | Covers |
| --- | --- | --- | --- |
| Kotlin common tests | `shared/*/src/commonTest` (`shared/core` has none) | `sharedJvmTest` on the JVM; `sharedAppleTest` natively on macOS, and with `-Pmobile.iosSimulatorId=<UDID>` also on that iOS simulator | the use cases, the in-memory repository, every ViewModel branch (content, empty, expected and unexpected failure, retry, not found, effects, `close()` cancelling work, a superseded or closed load that answers late never publishing, clearing the owning `ViewModelStore` without `close()`), `ScreenViewModel` effect buffering, `HomeSDK` |
| Android unit tests | `android/app/src/test`, `android/core/ui/src/test`, `android/feature/*/src/test` | `androidUnitTest` | the `SceneNavigation` queue and its saved state, including the values it drops; command encoding; `CollectEffects` delivery on a simulated main looper; router effect mapping; failure messages |
| Android instrumented tests | `android/app/src/androidTest/kotlin/cz/semprec/app/` (`SmokeFlowTest`, `HomeStackTest`, `LaunchIntentTest`) | `connectedDebugAndroidTest` on a device | the app on the real SDK: list, detail and back; a detail over another item's detail; ids such as `"null"`; Settings, About with the version, and Done; a Home command right after recreation with Settings selected; every item id reaching its detail entry unchanged; a launch with extras named like the saved keys, with Navigation's deep-link extras to the detail (without arguments, with a `String` or an `Int` `itemId`, without the `itemId`, as `deepLinkExtras`, in a `FLAG_ACTIVITY_NEW_TASK` launch) or with a data URI, and a new intent with deep-link extras and a data URI delivered to the running activity with `FLAG_ACTIVITY_SINGLE_TOP`, each showing the Home list without a detail or a crash, with the activity handing none of it on (`LaunchIntentTest`, which reads the graph and destination ids from the real Home graph) |
| Swift unit tests | `apple/Modules/*/*/Tests`, `apple/Projects/App/Tests` | the `Semprec` scheme's test action, on macOS and on an iOS simulator | `CoreKitTests`: every mapping branch of the bridges over Kotlin values (`SharedMappingTests`), the bridges over the real Kotlin ViewModels (`SharedScreenModelTests`), and `EffectQueue`; `HomeFeatureTests`, `SettingsFeatureTests`: the feature ViewModels over `ScriptedScreenModel`, failure messages, item titles; `SemprecTests`: the routers and `NavigationContext` over a `StackSpy` and over a real root `Navigator` (the detail on top not pushed again, also after a back swipe, the adapter's `top`, registering the same navigator again) (`NavigationTests`), the real `AppScene` in a window, where the Home router pushes the detail onto the Home stack and the Settings router presents About as a sheet over the Settings stack, and on macOS a click on a list row right of its label opens the row (`AppSceneNavigationTests`), and a closed scene releasing its composition (`SceneLifetimeTests`) |
| Apple UI tests | `apple/Projects/App/UITests` (`SmokeFlowTests`) | the `SemprecUITests` scheme's test action, on an iOS simulator only | the installed app driven by XCUITest through the test identifiers above, as Android's `SmokeFlowTest` does: list to detail (the title of the tapped row) and Back, then another detail that shows its content; Settings, the About sheet with the version and build, and Done; each tab keeping its own stack across a tab switch |

The Kotlin common tests share `FakeRepository` (whose `Behavior.Late` answers only
after a gate opens, also after its caller was cancelled), `MainDispatcherTest` and
`ViewModelStore.provide { }`, which creates a ViewModel in a real `ViewModelStore`
as Android does, from
`shared/presentation/src/commonTest/.../PresentationTestSupport.kt`. Every Swift
unit test bundle is hosted in `Semprec.app`, which embeds `SharedSDK` (`TEST_HOST`, with
its own path for macOS); only `SemprecTests` links against the app executable
(`BUNDLE_LOADER`). `SemprecUITests` is not hosted: it launches the app it depends
on (`appUnderTest` `Semprec` in the policy) and runs on iOS only, so on macOS the
in-process `AppSceneNavigationTests` are the only tests of the shown scene's
navigation, and
no macOS test tells which view the About sheet shows (a macOS sheet window has
no title). detekt (`detektAll`), Android
lint (`:android:app:lintDebug`) and SwiftLint (`swiftlint lint --strict` in
`apple/`, version 0.65.1 pinned by `swiftlint_version` in `apple/.swiftlint.yml`)
check the code statically. `scripts/verify` runs all of it
([verify.md](verify.md)).

## iOS and macOS

The Apple app is one set of targets, each built for iPhone, iPad and Mac (the
XCUITest target for iPhone and iPad only). These are the places where the two
platforms differ:

| Where | What differs |
| --- | --- |
| `apple/Modules/Core/DesignSystem/Sources/View+InlineNavigationTitle.swift` | one of the two files with an `#if os(...)` in the sources of the modules and the app, both in DesignSystem: `inlineNavigationTitle()` applies `navigationBarTitleDisplayMode(.inline)` on iOS and nothing on macOS. `DetailScreen` and `AboutScreen` use it |
| `apple/Modules/Core/DesignSystem/Sources/View+ListRowButton.swift` | the other one: `listRowButton()` keeps the system style on iOS, where a `Button` in a `List` already is a whole-row action that highlights when tapped, and applies the private `ListRowButtonStyle` on macOS, where a list keeps the bordered push button that reacts only on its capsule: the label leading-aligned across the row's full width (`.frame(maxWidth: .infinity, alignment: .leading)`), `.contentShape(Rectangle())` so the whole row reacts to a click, and `Theme.Opacity.pressed` while pressed. The button stays a button for accessibility on both. Every list row that is a `Button` uses it (`HomeScreen`, `SettingsScreen`). Arrow keys and Return do not move through a macOS list, which would need `List(selection:)` |
| `apple/Projects/App/Tests/Support/SceneWindow.swift` | one of the two test files with an `#if os(...)`, the window helper of the app's tests: it hosts a view in an `NSWindow` of a fixed 480 by 640 points on macOS (`NSHostingController.sizingOptions = []`, because a tab view sized to its content collapses the window to no width) and in a `UIWindow` of the app's `UIWindowScene` on iOS, with AppKit and UIKit types reached through `import SwiftUI` only, and reads what the window shows: `stackTitle`, `presentsSheet`, on iOS `sheetTitle`, on macOS `clickRow(_:atFraction:)` and `listRowCount` |
| `apple/Projects/App/Tests/AppSceneNavigationTests.swift` | the other test file with an `#if os(...)`: on iOS it also checks the About sheet's title, which a macOS sheet window does not show, and on macOS it clicks a row at 85 % of its width, where only a whole-row button reacts |
| `apple/Tuist/ProjectDescriptionHelpers/SemprecProject.swift` | `TEST_HOST` is `Semprec.app/Semprec` on iOS and, through `TEST_HOST[sdk=macosx*]`, `Semprec.app/Contents/MacOS/Semprec` on macOS |
| `apple/Projects/App/Project.swift` | `CODE_SIGN_ENTITLEMENTS[sdk=macosx*]` applies `apple/Projects/App/Entitlements/Semprec.entitlements` (the App Sandbox only) to the macOS app; macOS ignores the plist's UIKit keys. The XCUITest target `SemprecUITests` builds for iPhone and iPad only, and its scheme runs on an iOS simulator only, because macOS XCUITest needs the Accessibility permission |
| `scripts/kmp-framework` | `SDK_NAME` selects the Kotlin target (`iphoneos`: `IosArm64`, `iphonesimulator`: `IosSimulatorArm64`, `macosx`: `MacosArm64`) and the embed folder (`.app/Frameworks` or `.app/Contents/Frameworks`) |
| `build-logic/src/main/kotlin/semprec.kmp.gradle.kts` | the `macosArm64` target is built for `macosMinimum`, the iOS targets for `iosMinimum` |

Tuist generates the runpaths of each SDK itself (`Frameworks/` in an iOS bundle,
`Contents/Frameworks/` in a macOS bundle).

## Architecture check

`scripts/architecture.mjs` checks the rules that Gradle, Tuist and the compilers do
not enforce, against what `scripts/architecture-policy.json` allows (the module
graphs, the targets that may import the Kotlin framework or a navigation library,
and the copy keys of each module):

| Rule | Checks |
| --- | --- |
| `ARCH-GRADLE` | Gradle modules and their project dependencies follow the policy, without a cycle |
| `ARCH-APPLE` | Apple targets, their Tuist dependencies and their Swift imports follow the policy; the UI test target depends on its app under test without importing it, and a source file a target borrows from another directory is checked against the borrowing target's policy |
| `KMP-COMMON` | no platform import in `commonMain` |
| `KMP-FRAMEWORK` | only the policy's Kotlin framework target (CoreKit) and the targets whose `allowed` list names the framework (`CoreKitTests`) import it |
| `VM-BRIDGE` | every shared screen ViewModel, also one that extends `ScreenViewModel` through another class, has a test, exactly one CoreKit bridge that closes it in `deinit`, and an Android screen |
| `NAV-OWNERSHIP` | navigation libraries and controllers stay in the app modules (on Apple the app target and its tests, `SemprecTests`) and out of ViewModels |
| `APPLE-IDENTITY` | `gradle/project.properties` and `ProjectConfiguration.swift` agree |
| `ORG-SCREEN` | a `<X>Screen.kt` directly in a `presentation/screen/<folder>/` has `<X>ScreenLayout.kt` next to it; a `<X>ViewModel.swift` directly in a folder below a `Screens/` directory has `<X>Screen.swift` next to it. It looks into no other folder, so a screen or ViewModel placed elsewhere passes it, and the platforms' review (`tasks/architecture.md`) checks where screen files sit |
| `COPY-PARITY` | Android and Apple copy keys match the policy, each with a non-empty English and Czech value, and Android copy lives only in `src/main/res` (`src/androidMain/res` in a Kotlin Multiplatform module) |
| `WRAPPER` | `gradle/wrapper/gradle-wrapper.jar` matches the SHA-256 in `gradle/wrapper/gradle-wrapper.jar.sha256` |

[verify.md](verify.md#architecture-rules) states each rule in full and how to fix a
violation; `scripts/architecture.test.mjs` proves that each rule passes on the real
tree and fails on a violating copy, and `scripts/toolchain.test.mjs` tests the JDK and
SwiftLint prerequisites of `scripts/verify`, the `xcodebuild` commands of its `apple`
step (against stand-in tools), and the JDK lookup, the Gradle task per SDK and
configuration and the embed folder check of `scripts/kmp-framework`.

## Adding a feature

Load the `mobile-feature-create` skill (`.bb/skills/mobile-feature-create/SKILL.md`);
it holds the steps. Following the Settings feature, a new feature touches:

- shared: its state, action and effect types and ViewModel in
  `shared/presentation`, with common tests; its creation in
  `HomeViewModelFactory` and a method on `HomeSDK` in `shared/umbrella`.
- Android: a module `android/feature/<name>/` (applying `semprec.android.compose`,
  included in `settings.gradle.kts`) with its router and `handle`,
  `presentation/screen/<name>/<Name>Screen.kt` and `<Name>ScreenLayout.kt`,
  strings in English and Czech, test tags and unit tests; in `android/app`, a
  Koin `viewModel` in `AppModule.kt`, a `@Serializable` route in `AppRoutes.kt`
  with its `composable<T>` destination, and the router in `SceneNavigation` with
  its `NavigationCommand`s.
- Apple: in `apple/Modules/Core/CoreKit/`, the Swift values and `Scripted…`
  alias in `Sources/Models/`, a bridge in `Sources/Shared/` with its mapping
  tests in `Tests/SharedMappingTests.swift`, and a method on
  `ScreenModelFactory` and `SharedScreenModelFactory`; a module
  `apple/Modules/Features/<Name>/` with its `Project.swift`, listed in
  `apple/Workspace.swift` with its test target, a public `<Name>ScreenFactory`,
  `Sources/Layers/PresentationLayer/Screens/<Name>Screen/` (`<Name>Screen.swift`,
  `<Name>ViewModel.swift`), `Sources/Routing/<Name>Routing.swift`,
  `Resources/Localizable.xcstrings`, its identifiers and `Tests/`, every list row
  that is a `Button` styled with DesignSystem's `listRowButton()`; in the app,
  the dependency in `apple/Projects/App/Project.swift`, a router,
  `AppDestination` cases and the views in `AppScene`, for a new tab an `AppTab`
  case and its `Tab(…, value:)`, and, when the UI tests drive the feature, its
  `<Name>Identifiers.swift` in the `sources` of `SemprecUITests` with a flow in
  `Projects/App/UITests/`.
- The feature's Gradle module, Apple targets and copy keys in
  `scripts/architecture-policy.json`.

## Decisions

- [`docs/adr/2026-10-24-monorepo-holds-backend-web-and-mobile.md`](../../docs/adr/2026-10-24-monorepo-holds-backend-web-and-mobile.md)
- [`docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`](../../docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md)
- [`docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md`](../../docs/adr/2026-10-24-mobile-backend-calls-through-shared-data-layer.md)
- [`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`](../../docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md)
- [`docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`](../../docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md)
- [`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`](../../docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md)
- [`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`](../../docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md)
