Check how the Android screens host the shared screen ViewModels. Rule ID:
`SHARED-VM`.

1. A shared ViewModel created outside `koinViewModel` — in `remember { … }`, by
   calling `HomeSDK` from a composable, or constructed in a navigation
   destination — so it is recreated on recomposition or never cleared — high.
2. A second Android `ViewModel`, or `Screen`/`ScreenLayout` code, that maps or
   re-derives the shared state instead of rendering it — high. `SceneNavigation`
   is the app's navigation queue, not a screen ViewModel.
3. Effects collected with a plain `LaunchedEffect`/`collect` instead of
   `CollectEffects`, or a change to `CollectEffects` that stops collecting on
   `Dispatchers.Main.immediate` inside `repeatOnLifecycle(STARTED)` — high when
   navigation or a sheet can then run while the screen is stopped, run twice
   or be lost, otherwise medium: on an always-dispatching context a stop
   queued before the collector's resume drops the effect. A second collector
   of the same ViewModel's effects is high: the channel splits the effects
   between the two.
4. A `ScreenLayout` that takes a ViewModel, a Koin dependency or a router
   instead of immutable state and callbacks, that holds state of its own which
   the shared ViewModel provides, or a new `ScreenLayout` without a private
   preview — medium.
5. A new shared screen ViewModel not registered in `appModule` through
   `HomeSDK` (`viewModel { get<HomeSDK>().….() }`), or a registration that
   returns one instance to several screens — medium: each screen must own the
   ViewModel it is given, which its back-stack entry clears.

Not findings: different visual presentation of the same state on the two
apps.
