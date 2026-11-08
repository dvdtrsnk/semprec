---
name: shared-viewmodel
description: "How a mobile screen's logic is built: one shared ScreenViewModel<State, Action, Effect> in mobile/shared/presentation, hosted on Android by the ViewModelStore and on iOS and macOS by a CoreKit bridge that closes it in deinit. Load this BEFORE creating or changing a screen ViewModel, its state, actions or effects, or the code that hosts one on either platform. Triggers on: ScreenViewModel, onAction, emit(, update {, isClosed, close(), viewModelScope, HomeViewModel, DetailViewModel, SettingsViewModel, HomeViewModelFactory, HomeSDK, a new *State, *Action, *Effect or *Phase, koinViewModel, AppModule.kt, CollectEffects, collectAsStateWithLifecycle, ScreenModel, ScreenModelFactory, SharedScreenModelFactory, a Shared*ScreenModel bridge, SharedViewModelLease, EffectQueue, relay(, SharedMappingTests, ScriptedScreenModel, @StateObject, observe(), mobile/apple/Modules/Core/CoreKit/. Skip only when no screen logic and no ViewModel hosting changes."
---

# Screen logic lives in one shared ScreenViewModel. Native code renders it.

Recorded as ADRs: `docs/adr/2026-10-24-kotlin-multiplatform-below-native-mobile-ui.md`
(where logic lives) and
`docs/adr/2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting.md`
(the lifecycle and hosting contract below).

A screen's state, its reaction to each user intent and its one-time requests
(navigation, dialogs) are decided once, in Kotlin, and both apps render the
result. Native code renders state, forwards intents and maps effects to the
feature's router. It decides nothing. Why: a decision written twice is two
decisions, and the Android and Apple copies drift.

Load `kmp-shared` for the module graph and the Swift export rules,
`mobile-navigation` for what an effect turns into, and `mobile-feature-create`
for the full checklist of a new screen or feature.

## 1. The ScreenViewModel contract

The base class is
`mobile/shared/presentation/src/commonMain/kotlin/cz/semprec/app/presentation/ScreenViewModel.kt`.
Keep its contract when you change it, and follow it in every subclass:

- It extends the multiplatform androidx `ViewModel`. `state` is a
  `StateFlow<State>` of one immutable data class; a screen that loads has a
  `phase` enum in it (`HomeState`/`HomePhase`, `DetailState`/`DetailPhase`).
  Subclasses change it only through the protected `update { }`.
- `effects` is `Channel(Channel.UNLIMITED).receiveAsFlow()`. The channel
  delivers effects in emission order, each to at most one collector, and never
  replays one; effects emitted while nobody collects wait for the next
  collector. A collector cancelled after the channel handed it an effect but
  before it resumed drops that effect (the prompt cancellation of
  kotlinx.coroutines), so the flow on its own guarantees at most once.
- The hosts collect where that cannot happen: Android's `CollectEffects`
  collects on `Dispatchers.Main.immediate`, so an effect emitted on the main
  thread is processed before any lifecycle event can cancel the collector, and
  each Apple CoreKit bridge collects once for its whole life through its
  `EffectQueue`. Net guarantee: every effect emitted on the main thread is
  delivered exactly once while the ViewModel (Android) or the bridge (Apple)
  lives.
- Subclasses send through the protected `emit()`, and only on the main thread:
  from `onAction` (the hosts call it on the main thread) or from work in
  `viewModelScope` (`Dispatchers.Main.immediate`). Why: an effect emitted on
  another thread keeps only the at-most-once guarantee, and nothing checks the
  thread for you.
- The flow has one collector per ViewModel (`CollectEffects` on Android, the
  bridge's collecting task on Apple); never collect it a second time, because
  two collectors split the effects between them.
- `close()` is idempotent: it cancels `viewModelScope` and closes the effect
  channel, and the last state stays readable. Android's store clearing the
  instance ends the same (`viewModelScope` cancelled, `onCleared()` closes the
  channel), so a ViewModel must not need `close()` for anything else. `isClosed`
  is `true` after either, an effect emitted afterwards is dropped, and the
  effects emitted before are still handed to the next collector before the
  flow completes.
- Every concrete `onAction` starts with `if (isClosed) return`. Why: without it
  a `Retry` after `close()` still runs `update { XState() }` and puts a closed
  screen back into LOADING.
- A load cancels the previous one (`loadJob?.cancel()`), publishes the initial
  state, and runs the use case in `viewModelScope.launch`. It rethrows
  `CancellationException` before it catches `Exception`, calls
  `ensureActive()`, and only then calls `update { next }`. Copy that shape from
  `HomeViewModel.load()`. Why: a superseded or closed load must neither
  publish a stale result nor turn its cancellation into an error, and a
  repository call can return its result after its caller was cancelled.
- An expected failure is a value in state: phase `ERROR` plus
  `failure: FailureKind`. An unexpected exception is `ERROR` with
  `failure = null`, never a message. Cancellation is never a state.
- State carries no display text, only phases, `FailureKind` and ordinals.
  Native code renders the text from its own resources
  (`docs/adr/2026-10-24-mobile-copy-localized-natively-from-typed-state.md`,
  `canonical-keys`).
- A screen without effects declares `Nothing` as its effect type
  (`DetailViewModel`). Its Android screen collects no effects, and its CoreKit
  bridge returns a stream that finishes at once.
- Constructors are `internal`. `HomeViewModelFactory` (presentation,
  `@HiddenFromObjC`) is their only caller, and `HomeSDK`
  (`mobile/shared/umbrella/src/commonMain/kotlin/cz/semprec/app/sdk/HomeSDK.kt`)
  composes repository, use cases and factory. Every SDK call returns a new
  ViewModel that its caller owns. Why: one instance per screen presentation is
  what makes the closing rules below decidable.

`when` over a sealed action, effect or enum has no `else`, so a new case fails
the build on every consumer instead of falling through silently.

## 2. Hosting: who owns the instance, and who closes it

| | Android | Apple (one SwiftUI codebase, iOS and macOS) |
|---|---|---|
| Created by | `koinViewModel<XViewModel>()` in the app's tab host (`HomeTabHost.kt`, `SettingsTabHost.kt`), from the `viewModel { get<HomeSDK>().xViewModel() }` entries in `AppModule.kt` | the feature's `XScreenFactory`, inside the `@StateObject(wrappedValue:)` autoclosure of the screen |
| Owner | the `ViewModelStore` of the screen's navigation entry | the feature's `ObservableObject` ViewModel, which holds `any XScreenModel`, a CoreKit bridge |
| State | `collectAsStateWithLifecycle()` in `XScreen` | `model.state` (synchronous) for the first render, then `observe()` in the screen's `.task` |
| Effects | `CollectEffects(viewModel.effects, router::handle)`, only while STARTED, on `Dispatchers.Main.immediate` | `model.observe(onState:onEffect:)`, then the feature ViewModel's `route(_:)` calls the router |
| Closing | the store clears it when the entry leaves the back stack; Android never calls `close()` | the bridge's `deinit { lease.close() }` calls the Kotlin `close()` exactly once |
| Previews and tests | layouts take literal state; router mappings have JVM tests | `Scripted*ScreenModel`, which never starts the Kotlin runtime |

The feature never sees a Kotlin type on Apple. CoreKit is the only module
whose sources import `SharedSDK`; only its test target, `CoreKitTests`, imports
it too (`kmp-shared`).

### The CoreKit bridge (Apple)

One bridge per Kotlin ViewModel, in
`mobile/apple/Modules/Core/CoreKit/Sources/Shared/Shared<X>ScreenModel.swift`:
an internal `@MainActor final class` conforming to the `ScreenModel` protocol
(`Sources/ScreenModel.swift`) through the typealias in
`Sources/Models/<X>ScreenModel.swift`. Copy `SharedHomeScreenModel`:

- `let lease: SharedViewModelLease` created with `{ viewModel.close() }`, and
  `deinit { lease.close() }`.
- `state` maps `viewModel.state.value`. `states()` is
  `relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)`: one
  SKIE iteration per observer, ended by cancelling it. A `StateFlow` starts
  with its latest value, so a new observer misses nothing.
- When the ViewModel has effects, they are collected once per bridge, never
  per observer: `effectQueue = EffectQueue(collecting: viewModel.effects, Self.effect)`
  in `init`, and `effects()` returns `effectQueue.stream()`. A bridge whose
  Kotlin effect type is `Nothing` has neither queue nor collecting task, and its
  `effects()` returns `AsyncStream { $0.finish() }` (`SharedDetailScreenModel`).
  Why the queue: a SKIE flow iterator starts collecting when it is created and
  stops only when it is deallocated, not when its task is cancelled. An effect
  it already took from the Kotlin channel then never reaches Swift.
  `SharedScreenModelTests.swift`
  drives the real Kotlin ViewModels through stopped, cancelled and repeated
  observation to prove each effect still arrives once.
- `EffectQueue` (`Sources/EffectQueue.swift`) hands each effect to one
  observer once, in order. Only the task iterating the newest `stream()`
  takes effects, and only while it is not cancelled. Effects nobody took wait
  for the next stream. `ScriptedScreenModel` uses the same queue, so previews
  and tests see the same delivery.
- The mappings are internal `static` functions in an extension under
  `// MARK: - Mapping`: `state(_:)` (Kotlin state to Swift state),
  `action(_:)` (Swift action to Kotlin action) and, with effects, `effect(_:)`,
  each an exhaustive `switch`. `send(_:)` is only
  `viewModel.onAction(action: Self.action(action))`. Why: `CoreKitTests` reach
  the functions through `@testable import CoreKit` and check every branch with
  Kotlin values they build (`SharedMappingTests.swift`); the in-memory
  repository never produces most of them.

### The Apple owner: `@StateObject`, not `@Observable`

The feature ViewModel is a `@MainActor final class XViewModel: ObservableObject`.
`XScreen` stores it as `@StateObject private var viewModel` and takes it as
`init(viewModel: @autoclosure @escaping () -> XViewModel)`. `XScreenFactory`
writes `XScreen(viewModel: XViewModel(model: makeModel(), router: router))`,
so `makeModel()` runs once, when SwiftUI creates the state object. Why: an
`@Observable` class in `@State` is built by an initial-value expression that
runs on every init of the view struct, and each run would create and then
discard a Kotlin ViewModel (the ADR records the decision).

`observe()` runs in the screen's `.task`, so SwiftUI cancels it when the
screen disappears. Each `.task` run calls `effects()` again, and that newer
stream ends the previous one.

The only native androidx `ViewModel` in the apps is `SceneNavigation`, the
Android app's navigation queue (`mobile-navigation`). Do not add an Android or
Swift ViewModel that makes decisions for a screen. A screen with no decisions
has no ViewModel at all: the About screen is `AboutScreenLayout` on Android and
`AboutScreen` on Apple.

## 3. Tests per layer

Each layer proves something the others cannot, so a screen change touches
every row that applies:

| Layer | Where | What it proves |
|---|---|---|
| Shared ViewModel | `mobile/shared/presentation/src/commonTest/` (`MainDispatcherTest`, `FakeRepository` and `ViewModelStore.provide { }` in `PresentationTestSupport.kt`) | every phase; each action's effect emitted exactly once; retry; a newer load cancels the older one (`FakeRepository.Behavior.Never`, `cancellations`); a superseded or closed load that answers late never publishes (`Behavior.Late`, `lateAnswers`); `close()` idempotent and cancelling in-flight work without a failure state; a closed ViewModel ignores actions; clearing the owning `ViewModelStore` without `close()` does the same |
| SDK | `mobile/shared/umbrella/src/commonTest/` (`HomeSDKTest`) | every call returns a new ViewModel |
| Android feature | `src/test/` of the feature (`HomeRouterTest`) | each effect reaches the right router call |
| Android effect delivery | `mobile/android/core/ui/src/test/` (`CollectEffectsTest`) | `CollectEffects` delivers each effect emitted on the main thread once, in order, also when a stop was already queued, and effects emitted while stopped on the next start |
| CoreKit bridge | `CoreKit/Tests/SharedMappingTests.swift` and `CoreKit/Tests/SharedScreenModelTests.swift` | `SharedMappingTests`: every branch of `state(_:)`, `action(_:)` and `effect(_:)` and of the shared values, over Kotlin values it builds. `SharedScreenModelTests`: the real Kotlin ViewModel through the bridge: content, retry making the Kotlin ViewModel load again, each effect delivered once across cancelled and repeated observation, releasing the bridge closes the Kotlin ViewModel |
| Apple feature | `Tests/<X>ViewModelTests.swift` over `Scripted*ScreenModel` | intents forwarded, effects routed (including ones raised before observation), releasing the ViewModel releases its model (a `weak` reference) |
| Runtime | `SmokeFlowTest` (Android, on a reserved emulator), `SmokeFlowTests` of `SemprecUITests` (Apple, on a reserved iOS simulator; no UI test runs on macOS) | open, close and reopen the screen: the second presentation renders content |

The shared tests run on the JVM (`sharedJvmTest`) and natively
(`sharedAppleTest`). Load `testing` for the discipline that makes a test able
to fail, and `mobile-verify` for the commands.

The `VM-BRIDGE` rule of `mobile/scripts/architecture.mjs` checks the
structure: every non-abstract class of the presentation module's `commonMain`
that extends `ScreenViewModel`, directly or through other classes declared
there, has a `<Name>Test.kt` in `commonTest`, exactly one CoreKit class
storing it and an Android `*Screen` taking it, and every CoreKit class that
stores a shared ViewModel or a lease closes its `SharedViewModelLease` in
`deinit`. It checks no test content and no effect delivery.

## Before committing, check

- [ ] The decision lives in the shared ViewModel or a use case; native code
      only renders, forwards and routes.
- [ ] State is immutable, has a `phase` when the screen loads, and carries no
      display text;
      expected failures are `FailureKind` values, unexpected ones
      `failure = null`, cancellation is rethrown.
- [ ] `onAction` starts with `if (isClosed) return`; a new load cancels the
      previous one and calls `ensureActive()` before publishing.
- [ ] The constructor is `internal`, and `HomeViewModelFactory` and `HomeSDK`
      return a new instance per call.
- [ ] Every `emit` runs on the main thread (`onAction` or `viewModelScope`).
- [ ] Android obtains it with `koinViewModel` in the app and collects effects
      with `CollectEffects`.
- [ ] The CoreKit bridge closes its lease in `deinit`, collects effects once
      through `EffectQueue(collecting:)` when the ViewModel has effects (or
      returns a finished stream for `Nothing`), relays state per observer, and
      keeps its mappings as internal static functions with a
      `SharedMappingTests` case per branch.
- [ ] The Apple screen creates its ViewModel only inside the `@StateObject`
      autoclosure and observes in `.task`.
- [ ] Every row of the test table that the change touches has a test that
      fails without the change.
