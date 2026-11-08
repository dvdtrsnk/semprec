---
status: accepted
date: 2026-10-24
area: [mobile]
supersedes: []
superseded-by: null
---

# The mobile apps own navigation; features declare routers and ViewModels never navigate

## Context

A shared ViewModel decides that something should open: Home raises `HomeEffect.OpenDetail(id)`
when an item is selected, Settings raises `SettingsEffect.ShowAbout`
([[2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting]]). How it opens is platform
UI: a screen pushed onto a tab's stack, a bottom sheet on Android, a sheet with a Done button on
iOS and macOS. Shared code cannot use any navigation API
([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]), and features should not know each
other, the app's tabs or the navigation library.

Android adds two constraints. A navigation request can arrive while the scene is not started, or
after the activity was recreated with another tab selected, when the Home tab's `NavHost` has not
set its graph yet and `navigate` fails. And a request must survive recreation and process death
without running twice.

The alternatives considered:

- **Navigation state in shared Kotlin** (a router or back stack in a ViewModel): it would put one
  platform's navigation model into code both apps share.
- **Features navigating themselves** with a `NavController` or a NavigatorUI `Navigator`: every
  feature would import the navigation library and know the destinations of other screens.
- **Android effects calling the `NavController` directly**: a request raised while the scene is
  stopped, or before the Home graph is set, would be lost or fail.
- **String routes in Navigation Compose** (`home`, `detail/{itemId}`, `settings`): an argument of
  `NavType.StringType` turns the literal `"null"` into a null value, so the detail of an item whose
  id is `"null"` would arrive without its id, and every id has to be encoded into the route
  (`Uri.encode`) by hand. Type-safe routes avoid both, at the cost of the kotlinx-serialization
  plugin and library in the app module.

## Decision

### Features declare routers

Each feature declares a router for the navigation it requests, and the app implements it:

- Android: `HomeRouter` (`showDetail(id)`, `closeDetail()`) and `SettingsRouter` (`showAbout()`) at
  the root package of each feature module.
- Apple: `HomeRouting` (`showDetail(itemId:)`) and `SettingsRouting` (`showAbout()`) in each
  feature's `Sources/Routing/`.

A feature maps its shared ViewModel's effects onto its router: `HomeRouter.handle` and
`SettingsRouter.handle` on Android, the private `route` method of the Apple feature ViewModels
whose screens have effects (`HomeViewModel`, `SettingsViewModel`). A screen calls its router
directly only for navigation that no shared ViewModel decides: Android's detail top-bar back arrow
calls `closeDetail()`, because the shared `DetailViewModel` has no action for leaving. On Apple,
leaving the detail is the system back button, and the About sheet's Done button dismisses through
`@Environment(\.dismiss)`; on Android the app's `AboutSheet` hides the sheet when the About
layout's `onDone` is called.

The app implements every router and owns every stack, tab and sheet. Features import no navigation
library: `androidx.navigation` is used only in `:android:app`, NavigatorUI only in
`mobile/apple/Projects/App`. No ViewModel holds navigation: a shared ViewModel only raises
effects, an Apple feature ViewModel holds at most its router protocol, and no `NavController` or
`Navigator` is passed into a feature.

### Android

- `SceneNavigation` (`navigation/SceneNavigation.kt` in `:android:app`), an activity-scoped
  AndroidX ViewModel, implements both routers by queueing `NavigationCommand`s (`Detail(id)`,
  `CloseDetail`, `About`), each with a sequence number. The queue is a `MutableStateFlow` mirrored
  into the `SavedStateHandle` under `pending_navigation` and `next_navigation_sequence`.
- `MainActivity` creates it with `createSavedStateHandle()` from `CreationExtras` that hold only the
  saved-state registry owner and the `ViewModelStore` owner, not the activity's default arguments
  (`DEFAULT_ARGS_KEY`). Those carry the extras of the intent that started the activity, which is
  the exported launcher activity, so any app that starts it could otherwise seed the queue.
- Navigation Compose reads the launch intent by a second path: when a tab's `NavHost` first sets its
  graph, its `NavHostController` runs `handleDeepLink(activity.intent)`, which follows Navigation's
  deep-link extras (`NavController.KEY_DEEP_LINK_IDS`, `KEY_DEEP_LINK_ARGS`, `KEY_DEEP_LINK_EXTRAS`)
  to the destination they name, without checking who sent them and around the queue. Another app
  could so reset the Home stack to a detail it chooses, or crash the app at launch with a detail
  whose `itemId` is missing or of another type. The app declares no deep link, so `MainActivity`
  replaces its intent with `withoutLaunchContent()` at the top of `onCreate`, before
  `super.onCreate`, on every creation (the system hands a recreated activity its original intent
  again), and `onNewIntent`, which a caller's `FLAG_ACTIVITY_SINGLE_TOP` reaches whatever the launch
  mode, hands `super` and every new-intent listener only `withoutLaunchContent()` of the new intent.
  `withoutLaunchContent()` is `cloneFilter()` without the data: it keeps the action, categories,
  component, package and identifier, and drops the extras, the data and its type, the clip data, the
  selector and the flags. The `CreationExtras` above stay as a second layer.
- `SceneNavigation` reads both keys as untyped values and narrows them. When it starts it drops a
  value of another type under either key, a queue entry that is no `String` or no command
  `decodeQueued` can read, and a later entry that repeats a queued sequence, and it rewrites both
  keys without them. The next sequence is above every queued one, so `acknowledge` removes exactly
  one command.
- `commands` emits the oldest unacknowledged command, and the next one only after
  `acknowledge(sequence)`. A new collection starts again from the oldest unacknowledged command.
  `commands` serves one collector at a time.
- `AppScene` collects `commands` only while STARTED (`repeatOnLifecycle`), runs each command with
  the suspending `AppSceneState.execute` and acknowledges it right after. For `Detail` and
  `CloseDetail`, `execute` selects the Home tab and waits until the Home `NavHost` has set its graph
  (`homeStack.currentBackStackEntryFlow.first()`) before it navigates; `About` sets
  `aboutVisible`. Nothing suspends after a command took effect, so a command interrupted before it
  ran is delivered again, and one that ran is never delivered again, across a stopped scene,
  recreation and process death.
- Each tab has its own `NavHostController`. The destinations are type-safe Navigation Compose
  routes in `AppRoutes.kt` of `:android:app`: `@Serializable data object HomeRoute`,
  `@Serializable data class DetailRoute(val itemId: String)` and `@Serializable data object
  SettingsRoute`, declared with `composable<T>` and read with `toRoute<T>()`. A route argument is a
  non-null typed property of its route class: a non-null `String` comes back exactly as it went in,
  the literal `"null"`, the empty string and route characters such as `/`, `?`, `%` and `#`
  included, so the detail reads its id without `requireNotNull`. `semprec.android.application`
  applies the kotlinx-serialization plugin, and the app depends on `kotlinx-serialization-core`.
- `Detail(id)` pushes a new `DetailRoute(id)` entry, with its own `ViewModelStore` and so its own
  `DetailViewModel`, unless the entry on top already is the detail of that id. Details of different
  items can therefore stack, as on Apple, which skips the detail on top the same way, and Back or
  `CloseDetail` on a detail opened over another returns to that one. A destination whose ViewModel
  is built from navigation arguments is never navigated to with `launchSingleTop`: single-top
  replaces the top entry's arguments but keeps its id and `ViewModelStore`, so `koinViewModel` would
  hand the new detail the previous item's ViewModel. `CloseDetail` pops the top detail only
  (`popBackStack<DetailRoute>(inclusive = true)`), never the list.
- The selected tab and the About sheet's visibility are `rememberSaveable`. Back on the Settings
  root returns to Home.

### Apple

- `AppScene` holds one `AppComposition` per window as a `@StateObject`. The composition owns a
  `NavigationContext` and the routers `AppHomeRouter` and `AppSettingsRouter`.
- `AppScene` holds the window's root NavigatorUI `Navigator` in its own `@State` and passes it to
  `.navigationRoot`; the composition never holds it. NavigatorUI keeps the destination provider in
  the root navigation state for as long as that state lives, with no way to unregister it, and on
  macOS AppKit kept a closed window's tab bar environment, root navigator included, alive in the
  test that hosts a scene in a window. So every closure `AppScene` hands NavigatorUI calls static
  functions and captures only the composition, never the scene view (`self`), whose `@State` and
  `@StateObject` storage lead back to that state, and the destination provider captures the
  composition weakly. A closed window then releases its composition, with its
  `NavigationContext`, its routers and the screen model factory that owns its Kotlin `HomeSDK`,
  even where AppKit keeps the root navigation state alive.
- `AppScene`'s `TabView(selection:)` has one `Tab(…, value:)` per `AppTab`; the selected tab is
  its `@State`, `.home` unless `init(composition:selectedTab:)` names another.
- Each tab is a NavigatorUI `ManagedNavigationStack`. In `onAppear` its root screen registers the
  stack's `Navigator` in the context (`register(_ navigator:for:)`), which adapts it as a
  `StackNavigating` (`NavigatorStackAdapter`). A registration of the navigator already
  registered keeps its adapter, because the root registers on every appearance; one of another
  navigator replaces the stack registered before.
- `NavigationContext.push` skips a destination equal to the stack's `top`, as Android skips the
  detail of the same id on top: the same effect delivered twice opens one detail on both
  platforms, and the detail of another item stacks. NavigatorUI exposes how many entries a path
  holds, not which, so `NavigatorStackAdapter` remembers the destinations it pushed and reconciles
  them with `navigator.count`; the system removes entries only from the end (Back, a back swipe,
  a pop), so `top` stays right after them. This relies on the adapter being the only code that
  appends to the path, which holds because only the app imports NavigatorUI and pushes only
  through its routers; an entry other code appended leaves `top` unknown (nil), and every push
  goes through, until it is popped.
- `AppHomeRouter` pushes `AppDestination.detail(itemId:)` onto the Home stack; `AppSettingsRouter`
  presents `AppDestination.about` as a sheet over the Settings stack. `AppScene` provides the view
  of every `AppDestination` in one `.onNavigationProvidedView(AppDestination.self)`, because the
  features that render them know neither each other nor the navigation library.
- A route for a tab whose stack has not registered yet does nothing. There is no process-wide
  navigator, so windows never navigate each other.

## Consequences

- New navigation is a router method in the feature and its implementation in each app: a
  `NavigationCommand` (with its saved encoding) and an `AppSceneState.execute` branch on Android,
  plus a `@Serializable` route in `AppRoutes.kt` for a new destination; an `AppDestination` case
  and its view on Apple.
- The same effect can be presented differently on each platform (About is a bottom sheet on
  Android and a sheet with a toolbar on Apple) without a change to shared code.
- Android restores pending commands, the tab, the open sheet and each tab's back stack after
  process death. Apple restores no navigation after the process ends.
- On Apple a route raised before its tab's stack registered is dropped. Every route today comes
  from a screen shown in that tab's own stack, which has registered by then.
- A second collector of `SceneNavigation.commands` would run every command twice; `MainActivity`
  hosts one `AppScene`.
- `NAV-OWNERSHIP` in `mobile/scripts/architecture.mjs` fails on an `androidx.navigation` import or a
  `NavController`/`NavHostController` outside `:android:app` or in any ViewModel, and on a
  NavigatorUI import outside the app target and its tests (`SemprecTests`, which drive the real
  stacks) or in a `*ViewModel.swift` file.
- The apps declare no deep link, and Android discards whatever the launch intent and every new
  intent carry. The first deep link needs its own decision, and its Android side reads the
  original intent in `MainActivity` on purpose, validating it there.
- `SceneNavigationTest` covers the queue, acknowledgement, restoration from a reconstructed
  `SavedStateHandle` and the saved values it drops, and `QueuedNavigationTest` round-trips every
  command, ids such as `"null"`, `""` and route characters included. The instrumented
  `SmokeFlowTest.aHomeCommandRightAfterRecreationOnSettingsWaitsForTheHomeStackAndRuns` covers the
  wait for the Home graph, and its detail cases cover a detail opened over another item's detail,
  a second detail of the item on top, and ids such as `"null"`. `HomeStackTest` checks that every
  item id reaches its detail entry unchanged. `LaunchIntentTest` checks that a launch with extras
  named like the saved keys, with Navigation's deep-link extras to the detail (ids read from the
  real Home graph; without arguments, with a `String` or an `Int` `itemId`, without it, as
  `deepLinkExtras`, in a `FLAG_ACTIVITY_NEW_TASK` launch) or with a data URI, and a new intent
  with deep-link extras and a data URI delivered with `FLAG_ACTIVITY_SINGLE_TOP`, each show the
  Home list without a detail or a crash, and that the activity hands none of it on. On Apple, `NavigationTests` cover the routers, the
  skipped detail on top on a spy and on a real `Navigator` (also after a back swipe), the
  adapter's `top` and a repeated registration; `AppSceneNavigationTests` show the real `AppScene`
  in a window and check that the Home router pushes onto the Home stack and the Settings router
  presents About as a sheet over the Settings stack; `SceneLifetimeTests` checks that a closed
  scene releases its composition and its screen model factory; and the XCUITest `SmokeFlowTests`
  (`SemprecUITests`, iOS simulator only) walk the list, the detail, Back, About and a tab switch.
  No automated test kills the process.
