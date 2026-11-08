---
status: accepted
date: 2026-10-24
area: [mobile]
supersedes: []
superseded-by: null
---

# Shared screen ViewModels: one contract, hosted by Android's ViewModelStore and a closing CoreKit bridge

## Context

Each mobile screen's logic is a Kotlin ViewModel in `:shared:presentation`
([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]), and both native apps host it. The
hosts differ:

- Android keeps a ViewModel in a `ViewModelStore`, which clears it when its owner is gone and so
  cancels its `viewModelScope`.
- SwiftUI has no `ViewModelStore`, and a SwiftUI view has no `deinit`. Releasing a Kotlin
  ViewModel from Swift neither clears it nor cancels its `viewModelScope`, so the Swift side has to
  end it explicitly.

One-time requests from a ViewModel to its screen (open a detail, show About) need a delivery rule.
A `SharedFlow` without replay drops what nobody collects at that moment, for example while a
screen is stopped; an event kept in state with a "consumed" flag needs every host to write back.
A buffered channel hands each element to one receiver and keeps it while nobody receives, but a
receive in kotlinx.coroutines is promptly cancellable: a receiver cancelled after the channel handed
it an element and before its coroutine resumed drops that element. A receiver on a dispatcher that
always dispatches, such as Compose's on Android, resumes only after every message already queued on
the main looper, an `ON_STOP` included.

On Apple, effects cross one more hop, and two behaviours shaped it:

- A SKIE iterator over a Kotlin `Flow` starts collecting when it is created. Cancelling the Swift
  task makes its `next()` return `nil` but does not stop the Kotlin collection, which the iterator
  cancels only when it is deallocated (the generated `SkieSwiftFlowIterator` does so in `deinit`);
  an element it has taken from the ViewModel's channel by then never reaches Swift.
- A buffered `AsyncStream` hands the elements already in its buffer to a cancelled task that keeps
  iterating, and loses them when iteration stops.

Relaying effects to each observer through its own SKIE iterator, as the jsme-tu template this
platform is ported from does, therefore loses an effect raised right after an observer stops.
Collecting once and handing effects to each observer through a buffered `AsyncStream` would
deliver effects to a screen whose task was already cancelled, and lose the ones an observer had
not taken when it stopped iterating.

For holding the model in SwiftUI, the Observation framework (`@Observable` with `@State`) was the
alternative to `ObservableObject` with `@StateObject`.

## Decision

### The contract

`ScreenViewModel<State, Action, Effect>` (`ScreenViewModel.kt` in `:shared:presentation`) extends
AndroidX's multiplatform `ViewModel`:

- `state: StateFlow<State>` holds one immutable state; a collector gets the latest value first.
- `onAction(action)` is the only input. A concrete ViewModel ignores actions once `isClosed` is
  `true`.
- `effects: Flow<Effect>` carries one-time requests to the native owner. It is
  `Channel(UNLIMITED).receiveAsFlow()`, without `onUndeliveredElement`. It delivers effects in
  emission order, each to at most one collector, and never replays one; an effect emitted while
  nobody collects waits for the next collector. A collector cancelled after the channel handed it an
  effect but before it resumed drops that effect (the prompt cancellation of kotlinx.coroutines), so
  the flow on its own delivers each effect at most once. A screen without effects declares `Nothing`
  (`DetailViewModel`).
- `emit` is called only on the main thread: from `onAction`, which the hosts call on the main
  thread, or from work in `viewModelScope`, which runs on `Dispatchers.Main.immediate`. Every
  emitter does so today.
- The hosts collect where that window cannot open: Android's `CollectEffects` collects on
  `Dispatchers.Main.immediate`, so an effect emitted on the main thread is processed before any
  lifecycle event can cancel the collector, and each Apple CoreKit bridge collects once for its whole
  life through an `EffectQueue` (both below). So every effect emitted on the main thread is
  delivered exactly once while the ViewModel (Android) or the bridge (Apple) lives. An effect emitted
  on another thread keeps only the at-most-once guarantee. A second collector would split the
  effects between the two.
- `close()` cancels `viewModelScope` and closes the effect channel. A second call changes nothing.
  When Android's store clears the instance, it cancels `viewModelScope` and calls `onCleared()`,
  which closes the channel, so clearing ends everything `close()` ends. After either, `isClosed` is
  `true` for good, the state keeps its last value and an effect emitted afterwards is dropped.
  Effects emitted before and not yet taken are still handed to the next collector, and then the
  flow completes.
- Work runs in `viewModelScope`. A newer load cancels the older one and the older result is never
  published, also when the older load's repository call returns after its cancellation;
  `CancellationException` is rethrown and never becomes a state.
- Constructors are `internal`. Production code creates ViewModels only through `HomeSDK` (via the
  `@HiddenFromObjC` `HomeViewModelFactory`), and every call returns a new ViewModel that its caller
  owns. Android holds one `HomeSDK` for the process (`single` in `AppModule.kt`); Apple creates one
  per window (one `SharedScreenModelFactory` in each `AppComposition`). So state that must not be
  shared between windows or activities does not belong in `HomeSDK`: on Android every
  `MainActivity` of the process shares it, for example a second instance another app starts into
  its own task. `HomeSDK`'s KDoc states the same.

### Android hosting

`AppModule.kt` declares each ViewModel as a Koin `viewModel` definition, and the app's tab hosts
(`HomeTabHost.kt`, `SettingsTabHost.kt`) obtain it with `koinViewModel()` inside its `NavHost`
destination. It lives in that back-stack entry's `ViewModelStore`: it survives configuration
changes and is cleared when the entry leaves the stack. Android never calls `close()`. A feature
screen receives the ViewModel, collects its state with `collectAsStateWithLifecycle()` and, when
it has effects, collects them with `CollectEffects` (`:android:core:ui`). `CollectEffects` collects
only while the screen is STARTED (`repeatOnLifecycle`), and inside that block on
`Dispatchers.Main.immediate`: a collector suspended there resumes inside the `trySend` of an effect
emitted on the main thread, before the looper can run a queued `ON_STOP` or the composition's
disposal, so no lifecycle event can cancel it between hand-off and resume. Effects raised while the
screen is stopped wait in the channel and arrive on the next start. Layouts take values and
callbacks, never a ViewModel.

### Apple hosting

- CoreKit has exactly one internal bridge per Kotlin ViewModel class (`SharedHomeScreenModel`,
  `SharedDetailScreenModel`, `SharedSettingsScreenModel`), conforming to a Swift `ScreenModel`
  protocol over Swift value types. The bridge holds a `SharedViewModelLease` whose release calls
  the Kotlin `close()`, and closes the lease in `deinit`; the lease runs its release at most once.
- A feature's ViewModel (`HomeViewModel`, `DetailViewModel`, `SettingsViewModel` in the feature
  modules) is a `@MainActor final class … : ObservableObject` that owns `any <X>ScreenModel`. The
  screen holds it as `@StateObject`, and its initializer takes it as an `@autoclosure` passed to
  `StateObject(wrappedValue:)`. The feature's `*ScreenFactory` calls the app's `makeModel` closure
  inside that expression, so SwiftUI creates one bridge, and one Kotlin ViewModel, per screen
  identity. When SwiftUI releases the screen it releases the adapter and the bridge, which closes
  the Kotlin ViewModel.
- The adapter starts from `model.state`, read synchronously from the Kotlin `StateFlow`, so the
  first frame shows the current state. The screen observes in `.task { await viewModel.observe() }`,
  which SwiftUI cancels when the screen disappears.
- States: every `states()` call relays the Kotlin `StateFlow` into a new `AsyncStream` (`relay` in
  CoreKit) that ends when its task is cancelled; a new observer starts from the latest value.
- Effects: in every bridge whose ViewModel has effects, one task collects the Kotlin effect flow
  for the ViewModel's whole life and sends every effect into an `EffectQueue`
  (`EffectQueue(collecting:_:)`). Nothing cancels that task; it ends when `close()` completes the
  flow. Observers take effects only from the queue. `stream()` returns a pull-based
  `AsyncStream(unfolding:)` with no buffer of its own and ends the previous stream. An effect
  leaves the queue only when the task iterating the newest stream asks for one and is not
  cancelled. Effects nobody has taken (raised while no screen observes, raised while an observer's
  task is being cancelled, or left when an observer stopped) wait for the next stream, in order.
  An observer cancelled after it took an effect still handles it. Effects still queued when the
  bridge is released are dropped with the screen. A bridge whose ViewModel's effect type is
  `Nothing` has no collecting task and no queue; its `effects()` returns a stream that finishes at
  once (`SharedDetailScreenModel`).
- `ScriptedScreenModel` implements the same protocol over the same `EffectQueue`, so previews and
  feature tests drive a screen without a Kotlin ViewModel.

### Why `ObservableObject` and not `@Observable`

With the Observation framework the screen would own its model in `@State`. SwiftUI evaluates a
`@State` property's initial value every time it initializes the view, which happens whenever the
parent's body runs again, and keeps only the first instance. Each extra evaluation would create a
bridge and a Kotlin ViewModel (Home and Detail start loading in `init`) and close them again.
`StateObject(wrappedValue:)` takes an autoclosure that SwiftUI evaluates once per view identity.
Creating the model later, in `.task`, would lose the synchronous first state.

## Consequences

- A new shared screen needs: the Kotlin ViewModel with its `commonTest` tests, a `HomeSDK` method,
  a CoreKit bridge with its Swift values, a `Scripted*ScreenModel` alias and a
  `ScreenModelFactory` method, and an Android host. `VM-BRIDGE` in `mobile/scripts/architecture.mjs`
  treats as a screen ViewModel every class in the `commonMain` of `:shared:presentation` that
  extends `ScreenViewModel` directly or through other classes declared there. It fails when a
  non-abstract one has no `<Name>Test.kt` in `commonTest`, not exactly one CoreKit class storing
  it, or no Android `*Screen` composable taking it, and when a CoreKit class storing any of them
  (the base class and abstract ones included) or a `SharedViewModelLease` does not hold a lease and
  close it in `deinit`.
- In the apps only Swift calls `close()`. Android relies on its store, so a Kotlin ViewModel must
  not need `close()` for anything that clearing it (`viewModelScope` cancelled, `onCleared()`) does
  not also do. `ScreenViewModelTest` and the test of every screen ViewModel clear a real
  `ViewModelStore` without `close()` and check that running work is cancelled without an error
  state, the effect flow completes and a later action does nothing.
- The Kotlin effect flow has one collector per ViewModel: `CollectEffects` on Android, the bridge's
  collecting task on Apple. A second collector would split the effects between them.
- Every effect emitted on the main thread is delivered exactly once while the ViewModel (Android)
  or its bridge (Apple) lives, or waits for the next collector or observer. On Android
  `CollectEffectsTest` (`:android:core:ui`) proves it on a simulated main looper whose plain
  dispatcher always posts, as Compose's does: an effect emitted while an `ON_STOP` is already
  queued arrives once, and effects emitted while stopped arrive once, in order, on the next start.
  On Apple `SharedScreenModelTests` (against the real Kotlin ViewModels) and `EffectQueueTests` in
  `CoreKitTests` cover an observer cancelled before it took an effect and one that stopped.
- The guarantee rests on `emit` running on the main thread, which its KDoc requires and no check
  enforces. An effect emitted on another thread can still be lost on Android if the screen stops
  in the window between hand-off and resume.
