---
name: mobile-navigation
description: "Who navigates in the mobile apps and how - a shared ViewModel only emits an effect, the feature maps it to a router it declares, and the app implements the router and owns every tab, stack and sheet: on Android through type-safe routes and the SceneNavigation queue that runs each command once across recreation and process death, on iOS and macOS through NavigationContext and one NavigatorUI stack per tab. Load this BEFORE adding or changing a route, router, tab, sheet, back behaviour or navigation command. Triggers on: any *Router or *Routing, router::handle, route(_:), SceneNavigation, NavigationCommand, QueuedNavigation, acknowledge(, AppSceneState, AppRoutes, DetailRoute, toRoute, launchSingleTop, NavHost, NavHostController, navigate(, popBackStack, BackHandler, AboutSheet, AppTab, NavigationContext, StackNavigating, AppDestination, ManagedNavigationStack, NavigatorUI, onNavigationProvidedView, navigationRoot, a deep link, onOpenURL. Skip only when no navigation changes."
---

# The app navigates. Features ask. Shared ViewModels only emit effects.

Recorded as ADR: `docs/adr/2026-10-24-app-owned-mobile-navigation-through-feature-routers.md`.

Why this split: a ViewModel that held a navigation stack would tie shared code
to one platform's navigation library, and a feature that pushed its own
destinations could not be composed differently by the app. The `NAV-OWNERSHIP`
rule of `mobile/scripts/architecture.mjs` fails an `androidx.navigation` import
or a `NavController`/`NavHostController` in any Gradle module but `:android:app`
and in any ViewModel file there, and a NavigatorUI import in any Apple target
but the app and its tests (`SemprecTests`) and in any `*ViewModel.swift`.

## 1. The chain of one navigation

1. The user acts; the screen sends an action to the shared ViewModel.
2. The shared ViewModel decides and emits an effect
   (`HomeEffect.OpenDetail(id)`, `SettingsEffect.ShowAbout`). It never holds a
   router or a stack (`shared-viewmodel`).
3. The feature maps the effect to its own router contract, exhaustively:
   Android `internal fun HomeRouter.handle(effect: HomeEffect)` next to the
   interface in `HomeRouter.kt`, called through
   `CollectEffects(viewModel.effects, router::handle)`; Apple
   `XViewModel.route(_:)`, called from `observe()`.
4. The app implements the router and changes its own stacks.

The router contract lives at the feature root on Android
(`interface HomeRouter`, `interface SettingsRouter`) and in
`Sources/Routing/<Name>Routing.swift` on Apple
(`@MainActor public protocol HomeRouting: AnyObject`, plus an internal
`Preview<Name>Router` for previews). A route method names the destination in
the feature's terms (`showDetail`, `showAbout`), never a stack operation.

Going back is navigation only, so it needs no shared action. On Android the
detail's up button calls `router.closeDetail()` directly from `DetailScreen`;
on Apple the system back button pops the stack. The About sheet dismisses
itself natively (`AboutSheet`'s `onDismiss`, `@Environment(\.dismiss)` in
`AboutScreen`).

## 2. Android: an acknowledged command queue

The app owns `SceneNavigation`
(`mobile/android/app/src/main/kotlin/cz/semprec/app/navigation/SceneNavigation.kt`),
an androidx `ViewModel` of `MainActivity` built with `createSavedStateHandle()`
from `CreationExtras` that carry only the saved-state registry and
`ViewModelStore` owners. Never hand it the activity's default extras: their
`DEFAULT_ARGS_KEY` holds the extras of the activity's intent, and the launcher
activity is exported, so the queue would depend on what another app puts into
the launch intent as soon as the sanitizing below were removed. Leaving the key
out is the second layer behind that sanitizing, and no test isolates it:
`LaunchIntentTest` still passes with the key handed in, because the sanitized
intent carries no extras by the time `SceneNavigation` is created.

The launch intent reaches navigation by a second path too: when a tab's
`NavHost` first sets its graph, its `NavHostController` runs
`handleDeepLink(activity.intent)`, which follows Navigation's deep-link extras
(`NavController.KEY_DEEP_LINK_IDS`, `KEY_DEEP_LINK_ARGS`,
`KEY_DEEP_LINK_EXTRAS`) to any destination they name, without a sender check
and around the queue; a missing or mistyped `itemId` crashes the app in
`toRoute<DetailRoute>()`. So `MainActivity` sets
`intent = intent.withoutLaunchContent()` at the top of `onCreate`, before
`super.onCreate`, on every creation (a recreated activity is handed the
original intent again), and `onNewIntent`, which a caller's
`FLAG_ACTIVITY_SINGLE_TOP` reaches whatever the launch mode, hands `super` and
every new-intent listener only `intent.withoutLaunchContent()` of the new
intent. `withoutLaunchContent()` is `cloneFilter()` without the data: it keeps
the action, categories, component, package and identifier, and drops the
extras, the data and its type, the clip data, the selector and the flags. Keep
both places: removing or bypassing the sanitizing, or reading `intent` or a new
intent's extras or data to navigate without validating them where they are
read, lets any app drive or crash the app. The `CreationExtras` without
`DEFAULT_ARGS_KEY` stay as a second layer.

`SceneNavigation`'s `home` and `settings` objects implement the feature
routers, and each call enqueues a `NavigationCommand` (`Detail(id)`,
`CloseDetail`, `About`) as a `QueuedNavigation(sequence, command)`.

- The queue is a `MutableStateFlow` mirrored into `SavedStateHandle` under
  `pending_navigation` and `next_navigation_sequence`.
- `commands` delivers the oldest unacknowledged command, and the next one only
  after `acknowledge(sequence)`. A new collection starts again from the oldest
  unacknowledged command.
- `AppScene` collects `commands` only while STARTED (`repeatOnLifecycle`),
  calls the suspending `AppSceneState.execute(command)`, and acknowledges right
  after it returns.

Together that runs every command exactly once, also when the scene stops
before a command ran, across recreation and across process death. Keep all
three properties when you change it. `commands` serves one collector at a
time: two collectors would both run the same command.

`AppSceneState` (`AppSceneState.kt`) owns one `NavHostController` per tab
(`homeStack`, `settingsStack`), the selected `AppTab` and `aboutVisible`, both
in `rememberSaveable`. `execute` on a Home command selects `AppTab.HOME` and
suspends on `homeStack.currentBackStackEntryFlow.first()` until the tab's
`NavHost` has set its graph, then navigates. Why: a scene recreated with
Settings selected has a Home controller without a graph, and navigating it
throws (`SmokeFlowTest.aHomeCommandRightAfterRecreationOnSettingsWaitsForTheHomeStackAndRuns`).
Nothing may suspend after the command took effect, or a cancellation there
would run it twice.

Other Android details to keep:

- Routes are type-safe: `@Serializable data object HomeRoute`,
  `@Serializable data class DetailRoute(val itemId: String)` and
  `@Serializable data object SettingsRoute` in `AppRoutes.kt`, declared with
  `composable<T>` and navigated to with `navigate(DetailRoute(id))`; the
  destination reads `entry.toRoute<DetailRoute>().itemId`. A route argument is
  a non-null typed property of its route class. Why: a non-null `String` comes
  back exactly as it went in, while a string route's `NavType.StringType`
  turns the id `"null"` into a null argument; never read an argument with
  `requireNotNull` or `!!`.
- `Detail(id)` pushes a new entry for every detail, so each gets its own
  `ViewModelStore` and `DetailViewModel`; it skips only a detail of the same id
  already on top (a second tap that arrived with the first). Never navigate
  with `launchSingleTop` to a destination whose ViewModel is built from
  navigation arguments: single-top replaces the top entry's arguments but keeps
  its id and `ViewModelStore`, so `koinViewModel` returns the previous item's
  ViewModel.
- `CloseDetail` pops the top detail only
  (`popBackStack<DetailRoute>(inclusive = true)`), so a repeated close keeps
  the list, and a detail opened over another returns to that one.
- `HomeTabHost` and `SettingsTabHost` get each screen's ViewModel with
  `koinViewModel`, scoped to the navigation entry, so popping an entry clears
  its ViewModel.
- `rememberSaveableStateHolder` keeps each tab's UI state across tab switches,
  and a `BackHandler` on a non-Home tab's root returns to Home.
- `SceneNavigation` reads both saved keys as untyped values and narrows them
  (rule 6 of `.bb/AGENTS.md`). A value of another type under either key, an
  entry that is no `String`, an entry `decodeQueued` cannot read and a later
  entry repeating a queued sequence are dropped from the queue, and from
  `SavedStateHandle`, when it starts; the next sequence is above every queued
  one, so `acknowledge` removes exactly one command.

A new command needs a `NavigationCommand` case, its `encode()` and
`decodeCommand()` forms (`QueuedNavigationTest` round-trips every command), a
branch in `AppSceneState.execute`, and the router method in `SceneNavigation`
that enqueues it. A new destination also needs its `@Serializable` route in
`AppRoutes.kt` and its `composable<T>` in the tab's host.

## 3. Apple: one stack per tab, one context per scene

`AppScene` (`mobile/apple/Projects/App/Sources/AppScene.swift`) shows a
`TabView(selection:)` with one `Tab(…, value:)` per `AppTab`, and each tab one
NavigatorUI `ManagedNavigationStack`. The selected tab is `AppScene`'s
`@State`; the window opens on `.home` unless `init(composition:selectedTab:)`
names another tab, which the app's tests use. When a tab's root appears, it
calls `composition.navigation.register(navigator, for:)` on the scene's
`NavigationContext`, which wraps the stack's `Navigator` in a
`NavigatorStackAdapter`, and keeps the adapter already registered for the same
navigator (the same `navigator.id`): the root registers on every `onAppear`,
and a new adapter would forget what the stack holds.

- `AppDestination` (`detail(itemId:)`, `about`) lists every pushed or presented
  screen. `AppScene` provides the views in
  `.onNavigationProvidedView(AppDestination.self) { destination in … }` in
  closure form, because a method reference there crashed the Swift 6.2.1
  compiler.
- `AppHomeRouter.showDetail(itemId:)` calls
  `context.push(.detail(itemId:), in: .home)`; `AppSettingsRouter.showAbout()`
  calls `context.presentSheet(.about, from: .settings)`. `StackNavigating` has
  exactly these two operations and `top`, the destination on top of the stack
  (nil on its root, or when it cannot tell).
- `push` skips a destination equal to the stack's `top`, as Android's
  `execute` does: a second tap that arrives with the first opens the detail
  once, and the detail of another item still stacks. NavigatorUI tells how many
  entries a path holds (`navigator.count`), not which, so
  `NavigatorStackAdapter` remembers the destinations it pushed and reconciles
  them with `navigator.count`; Back, a back swipe and a pop remove entries from
  the end, so `top` stays right after them. That holds while the adapter is the
  only code that appends to the path, as it is in the app, where
  `NAV-OWNERSHIP` keeps NavigatorUI out of every other target; an entry other
  code appended makes `top` nil, and every push goes through, until that entry
  is popped. Never push onto a stack's `Navigator` past its adapter. `presentSheet` has no such check of its own; NavigatorUI
  ignores a sheet that is already presented.
- `NavigationContext` drops a route for a tab whose stack has not registered
  yet, and the registration of another navigator replaces the earlier one.
- Each window's `AppScene` creates its own `AppComposition`, so each window has
  its own `NavigationContext` and windows never navigate each other.
- `AppScene` holds the root `Navigator` in its own `@State`
  (`.navigationRoot(rootNavigator)`); `AppComposition` never holds it.
  `homeTab`, `settingsTab` and `destinationView` are `static`, every closure
  in `body` captures only the composition, never `self`, and the
  `.onNavigationProvidedView` provider captures it `[weak composition]`. Why:
  NavigatorUI keeps the provider in the root navigation state, with no way to
  unregister it, for as long as that state lives. Capturing `self` reaches the
  `@State` and `@StateObject` storage that hold that state, so the state keeps
  itself alive. And on macOS AppKit kept a closed window's tab bar
  environment, root navigator included, alive, so a provider that holds the
  composition strongly keeps it alive too. Either way every closed window would
  leak its composition and its Kotlin `HomeSDK`; `SceneLifetimeTests` checks
  that a closed scene releases its composition and its screen model factory,
  which owns the `HomeSDK`.

NavigatorUI is imported only in `Projects/App/Sources` and in the app's tests
in `Projects/App/Tests` (`ARCH-APPLE` allows it for `Semprec` and
`SemprecTests` only, and `NAV-OWNERSHIP`, whose owners are the same two
targets, also fails it in any `*ViewModel.swift`). A new destination needs an
`AppDestination` case, a branch in `destinationView`, and the router method in
the app's router; a new tab an `AppTab` case and its `Tab(…, value:)`.

The platforms deliver differently. Android queues and acknowledges commands;
Apple routes an effect synchronously on the main actor while the screen
observes, and `EffectQueue` keeps effects raised while it does not
(`shared-viewmodel` §2). Back and recreation may look different on each
platform; the business outcome (which destination opens, once) must not. Both
apps push a detail for every `OpenDetail`, except the detail of the same id
already on top, so a repeated effect opens one detail on each.

## 4. The apps declare no deep link yet

There is no URL scheme, no `VIEW` intent filter, no `deepLink` in a Navigation
graph and no `onOpenURL`. Navigation Compose still follows the deep-link
extras of the intent that starts `MainActivity` (§2); the Android app strips
them, and any data URI, in `MainActivity` before anything reads its intent.
The first deep link is an architectural decision: write its ADR first
(`adr-conventions`), and read it on purpose from the original intent in
`MainActivity`, which otherwise discards it. It has to define strict parsing
(unknown host, extra path components or a malformed id never navigate),
queueing until the scene is ready, delivery exactly once, and which stack it
resets.

## 5. Tests

| Platform | Test | Proves |
|---|---|---|
| Android feature | `HomeRouterTest`, `SettingsRouterTest` | each effect calls the right router method |
| Android app | `SceneNavigationTest`, `QueuedNavigationTest` | order, one command at a time, redelivery after a stopped collector, no redelivery after acknowledge, survival across reconstruction; dropped unreadable commands, saved values of another type under either key, non-`String` entries and duplicate sequences; the next sequence above every queued one; every command, and ids such as `"null"`, `""` and `"a/b?c=%20 d&e#f"`, round-tripped |
| Android device | `SmokeFlowTest`, `HomeStackTest`, `LaunchIntentTest` | list to detail and back, including recreation; a detail over another item's detail and back to the first; no second push of the detail on top; a detail for ids such as `"null"`; the About sheet and Done; a Home command right after recreation on Settings; every item id reaching its detail entry unchanged; a launch with extras named like the saved keys, with Navigation's deep-link extras to the detail (without arguments, with a `String` or `Int` `itemId`, without it, as `deepLinkExtras`, in a `FLAG_ACTIVITY_NEW_TASK` launch) or with a data URI, and a new intent with deep-link extras and a data URI delivered with `FLAG_ACTIVITY_SINGLE_TOP`, each showing the Home list with no detail and no crash, and the activity handing none of it on (ids read from the real Home graph) |
| Apple feature | `HomeViewModelTests`, `SettingsViewModelTests` | effects reach a router spy; for Home also effects raised before observation and while the screen was away, each routed once |
| Apple app | `NavigationTests`, `AppSceneNavigationTests`, `SceneLifetimeTests` (`SemprecTests`) | each router changes the right stack through a `StackSpy`, routes before registration are dropped, scenes do not share navigation; the detail on top is not pushed again and another item's detail stacks, also on a real `Navigator` after a back swipe; the adapter's `top` through pushes and pops, and an entry it did not push; registering the same navigator again keeps its adapter; in the real `AppScene`, the Home router pushes the detail onto the Home stack and the Settings router presents About as a sheet over the Settings stack, and on macOS a click on a row right of its label opens the row; a closed scene releases its composition and its screen model factory |
| Apple UI, iOS simulator | `SmokeFlowTests` (`SemprecUITests`) | list to detail and Back, then another detail with content; Settings, About with the version and Done; each tab keeping its stack across a tab switch |

A change to navigation updates the row of each platform it touches, and runs
the device tests on a reserved emulator and simulator (`mobile-verify`).

## Before committing, check

- [ ] No shared ViewModel or feature module holds a router implementation, a
      `NavController` or a NavigatorUI type.
- [ ] Each new effect has an exhaustive mapping to a router method and a test
      of that mapping on both platforms.
- [ ] A new Android command is encoded, decoded, executed and enqueued, and
      nothing suspends after it took effect.
- [ ] A new Android destination is a `@Serializable` route with non-null typed
      arguments, and no destination whose ViewModel takes navigation arguments
      is opened with `launchSingleTop`.
- [ ] A new Apple destination is an `AppDestination` case with a view in
      `AppScene`, routed by an app router method through the scene's
      `NavigationContext`, and no closure handed to NavigatorUI captures
      `self`.
- [ ] No deep link was added without an ADR, and `MainActivity` still
      replaces its launch intent and every new intent with
      `withoutLaunchContent()` before anything reads them.
- [ ] The navigation tests of each touched platform cover the change.
